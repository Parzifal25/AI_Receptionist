import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@halo/platform/env";
import {
  decryptCalendarCredential,
  encryptCalendarCredential,
  isEncryptedCalendarCredential,
} from "@halo/platform/calendar-credentials";

const KEY = "0123456789abcdef".repeat(4);

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
});

describe("calendar credential encryption", () => {
  it("round-trips with randomized authenticated ciphertext", () => {
    const first = encryptCalendarCredential("refresh-token-secret", KEY);
    const second = encryptCalendarCredential("refresh-token-secret", KEY);
    expect(first).not.toBe(second);
    expect(isEncryptedCalendarCredential(first)).toBe(true);
    expect(decryptCalendarCredential(first, KEY)).toBe("refresh-token-secret");
  });

  it("keeps legacy plaintext readable during staged backfill", () => {
    expect(decryptCalendarCredential("old-plaintext", KEY)).toBe("old-plaintext");
    expect(decryptCalendarCredential("", KEY)).toBe("");
  });

  it("reads with the previous key during the rotation window", () => {
    const oldCiphertext = encryptCalendarCredential("secret", KEY);
    vi.stubEnv("CALENDAR_CREDENTIALS_ENCRYPTION_KEY", "f".repeat(64));
    vi.stubEnv("CALENDAR_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS", KEY);
    resetEnvCacheForTests();
    expect(decryptCalendarCredential(oldCiphertext)).toBe("secret");
    expect(encryptCalendarCredential(decryptCalendarCredential(oldCiphertext))).not.toBe(oldCiphertext);
  });

  it("rejects wrong keys, tampering, malformed values, and invalid key sizes", () => {
    const encrypted = encryptCalendarCredential("secret", KEY);
    const [, iv, tag, data] = encrypted.split(".");
    expect(() => decryptCalendarCredential(encrypted, "f".repeat(64))).toThrow();
    expect(() => decryptCalendarCredential(`v1.${iv}.${tag[0] === "A" ? "B" : "A"}${tag.slice(1)}.${data}`, KEY)).toThrow();
    expect(() => decryptCalendarCredential(`v1.${iv[0] === "A" ? "B" : "A"}${iv.slice(1)}.${tag}.${data}`, KEY)).toThrow();
    expect(() => decryptCalendarCredential(`v1.${iv}.${tag}.${data[0] === "A" ? "B" : "A"}${data.slice(1)}`, KEY)).toThrow();
    expect(() => decryptCalendarCredential("v1.malformed", KEY)).toThrow();
    expect(() => decryptCalendarCredential("v1.!!!!.!!!!.!!!!", KEY)).toThrow(/Malformed/);
    expect(() => encryptCalendarCredential("secret", "short")).toThrow(/64 hexadecimal/);
  });
});
