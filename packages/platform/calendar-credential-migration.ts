import "server-only";
import {
  decryptCalendarCredential,
  encryptCalendarCredential,
  isEncryptedCalendarCredential,
} from "@halo/platform/calendar-credentials";

export const CALENDAR_CREDENTIAL_FIELDS = [
  "access_token",
  "refresh_token",
  "basic_username",
  "basic_password",
] as const;

export type CalendarCredentialField = (typeof CALENDAR_CREDENTIAL_FIELDS)[number];
export type CalendarCredentialRow = { id: string } & Record<CalendarCredentialField, string | null>;
export type CalendarCredentialMigrationMode = "encrypt" | "decrypt" | "reencrypt";

/** Transform one bounded batch and persist each row only if its source values still match. */
export async function migrateCalendarCredentialBatch(
  rows: CalendarCredentialRow[],
  mode: CalendarCredentialMigrationMode,
  compareAndSwap: (
    id: string,
    before: Record<CalendarCredentialField, string>,
    after: Record<CalendarCredentialField, string>,
  ) => Promise<boolean>,
): Promise<number> {
  let changed = 0;
  for (const row of rows) {
    const before = Object.fromEntries(
      CALENDAR_CREDENTIAL_FIELDS.map((field) => [field, row[field] ?? ""]),
    ) as Record<CalendarCredentialField, string>;
    const after = { ...before };

    for (const field of CALENDAR_CREDENTIAL_FIELDS) {
      const value = before[field];
      if (!value) continue;
      const encrypted = isEncryptedCalendarCredential(value);
      if (mode === "decrypt" && encrypted) after[field] = decryptCalendarCredential(value);
      else if (mode === "encrypt" && !encrypted) after[field] = encryptCalendarCredential(value);
      else if (mode === "reencrypt" && encrypted) {
        after[field] = encryptCalendarCredential(decryptCalendarCredential(value));
      }
    }

    if (CALENDAR_CREDENTIAL_FIELDS.every((field) => before[field] === after[field])) continue;
    if (!(await compareAndSwap(row.id, before, after))) {
      throw new Error(`Calendar credential row ${row.id} changed during migration; rerun the script`);
    }
    changed++;
  }
  return changed;
}

/** Confirm all non-empty values are ciphertext decryptable by the active key. */
export function verifyCalendarCredentialRow(row: CalendarCredentialRow, currentKey: string): void {
  for (const field of CALENDAR_CREDENTIAL_FIELDS) {
    const value = row[field] ?? "";
    if (!value) continue;
    if (!isEncryptedCalendarCredential(value)) {
      throw new Error(`Calendar credential row ${row.id} still contains plaintext`);
    }
    decryptCalendarCredential(value, currentKey);
  }
}
