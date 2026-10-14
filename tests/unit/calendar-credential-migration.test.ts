import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@halo/platform/env";
import {
  CALENDAR_CREDENTIAL_FIELDS,
  migrateCalendarCredentialBatch,
  verifyCalendarCredentialRow,
  type CalendarCredentialRow,
} from "@halo/platform/calendar-credential-migration";
import { encryptCalendarCredential } from "@halo/platform/calendar-credentials";

const OLD_KEY = "0123456789abcdef".repeat(4);
const NEW_KEY = "abcdef0123456789".repeat(4);

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
});

function row(id: string, values: Partial<Record<(typeof CALENDAR_CREDENTIAL_FIELDS)[number], string | null>> = {}): CalendarCredentialRow {
  return {
    id,
    access_token: values.access_token ?? "access",
    refresh_token: values.refresh_token ?? "refresh",
    basic_username: values.basic_username ?? "",
    basic_password: values.basic_password ?? null,
  };
}

describe("calendar credential migration", () => {
  it("encrypts only legacy values, leaves blanks and ciphertext alone, and safely resumes after a partial pass", async () => {
    vi.stubEnv("CALENDAR_CREDENTIALS_ENCRYPTION_KEY", NEW_KEY);
    resetEnvCacheForTests();
    const first = row("a");
    const second = row("b", { access_token: "", refresh_token: "legacy-refresh" });
    const stored = new Map([[first.id, first], [second.id, second]]);
    let failSecondOnce = true;
    const cas = async (id: string, before: Record<(typeof CALENDAR_CREDENTIAL_FIELDS)[number], string>, after: Record<(typeof CALENDAR_CREDENTIAL_FIELDS)[number], string>) => {
      const current = stored.get(id)!;
      if (CALENDAR_CREDENTIAL_FIELDS.some((field) => (current[field] ?? "") !== before[field])) return false;
      if (id === "b" && failSecondOnce) {
        failSecondOnce = false;
        return false;
      }
      stored.set(id, { ...current, ...after });
      return true;
    };

    await expect(migrateCalendarCredentialBatch([first, second], "encrypt", cas)).rejects.toThrow(/changed during migration/);
    const alreadyEncryptedAccess = stored.get("a")?.access_token;
    expect(alreadyEncryptedAccess).toMatch(/^v1\./);
    expect(stored.get("b")?.refresh_token).toBe("legacy-refresh");
    await expect(migrateCalendarCredentialBatch([stored.get("a")!, stored.get("b")!], "encrypt", cas)).resolves.toBe(1);
    expect(stored.get("b")?.access_token).toBe("");
    expect(stored.get("b")?.refresh_token).toMatch(/^v1\./);
    expect(stored.get("a")?.access_token).toBe(alreadyEncryptedAccess);
  });

  it("re-encrypts with the active key, verifies under that key, and supports decrypt rollback", async () => {
    vi.stubEnv("CALENDAR_CREDENTIALS_ENCRYPTION_KEY", NEW_KEY);
    vi.stubEnv("CALENDAR_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS", OLD_KEY);
    resetEnvCacheForTests();
    const oldAccess = encryptCalendarCredential("old-access", OLD_KEY);
    const stored = row("rotate", {
      access_token: oldAccess,
      refresh_token: encryptCalendarCredential("old-refresh", OLD_KEY),
      basic_username: encryptCalendarCredential("old-user", OLD_KEY),
      basic_password: encryptCalendarCredential("old-password", OLD_KEY),
    });
    const cas = async (_id: string, _before: Record<(typeof CALENDAR_CREDENTIAL_FIELDS)[number], string>, after: Record<(typeof CALENDAR_CREDENTIAL_FIELDS)[number], string>) => {
      Object.assign(stored, after);
      return true;
    };

    await expect(migrateCalendarCredentialBatch([stored], "reencrypt", cas)).resolves.toBe(1);
    expect(stored.access_token).not.toBe(oldAccess);
    verifyCalendarCredentialRow(stored, NEW_KEY);
    expect(() => verifyCalendarCredentialRow(stored, OLD_KEY)).toThrow();

    await expect(migrateCalendarCredentialBatch([stored], "decrypt", cas)).resolves.toBe(1);
    expect(stored.access_token).toBe("old-access");
    expect(stored.refresh_token).toBe("old-refresh");
    expect(stored.basic_username).toBe("old-user");
    expect(stored.basic_password).toBe("old-password");
  });

  it("fails closed on a compare-and-swap miss and verifies plaintext is not accepted", async () => {
    vi.stubEnv("CALENDAR_CREDENTIALS_ENCRYPTION_KEY", NEW_KEY);
    resetEnvCacheForTests();
    const pending = row("racy");
    await expect(migrateCalendarCredentialBatch([pending], "encrypt", async () => false)).rejects.toThrow(/rerun the script/);
    expect(() => verifyCalendarCredentialRow(pending, NEW_KEY)).toThrow(/still contains plaintext/);
  });
});
