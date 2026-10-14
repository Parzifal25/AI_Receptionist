import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getServerEnv } from "@halo/platform/env";

const PREFIX = "v1.";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Encrypts provider credentials with an externally managed 256-bit key. */
export function encryptCalendarCredential(
  value: string,
  keyHex = getServerEnv().CALENDAR_CREDENTIALS_ENCRYPTION_KEY,
): string {
  if (!value) return value;
  if (!keyHex) throw new Error("CALENDAR_CREDENTIALS_ENCRYPTION_KEY is required for calendar credentials");
  const key = parseKey(keyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

/** Decrypts v1 values; unprefixed values are legacy plaintext during rollout. */
export function decryptCalendarCredential(value: string, keyHex?: string): string {
  if (!value || !value.startsWith(PREFIX)) return value;
  const currentKey = keyHex ?? getServerEnv().CALENDAR_CREDENTIALS_ENCRYPTION_KEY;
  if (!currentKey) throw new Error("CALENDAR_CREDENTIALS_ENCRYPTION_KEY is required to read encrypted calendar credentials");
  const parts = value.slice(PREFIX.length).split(".");
  if (parts.length !== 3) throw new Error("Malformed encrypted calendar credential");
  const [ivText, tagText, dataText] = parts;
  if (![ivText, tagText, dataText].every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error("Malformed encrypted calendar credential");
  }
  const iv = Buffer.from(ivText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  const data = Buffer.from(dataText, "base64url");
  if ([iv, tag, data].some((bytes, i) => bytes.toString("base64url") !== [ivText, tagText, dataText][i])) {
    throw new Error("Malformed encrypted calendar credential");
  }
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("Malformed encrypted calendar credential");
  const tryKey = (key: string) => {
    const decipher = createDecipheriv("aes-256-gcm", parseKey(key), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  };
  try {
    return tryKey(currentKey);
  } catch (error) {
    const previousKey = keyHex ? undefined : getServerEnv().CALENDAR_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS;
    if (!previousKey || previousKey === currentKey) throw error;
    return tryKey(previousKey);
  }
}

export function isEncryptedCalendarCredential(value: string): boolean {
  return value.startsWith(PREFIX);
}

function parseKey(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error("CALENDAR_CREDENTIALS_ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes)");
  }
  return Buffer.from(keyHex, "hex");
}
