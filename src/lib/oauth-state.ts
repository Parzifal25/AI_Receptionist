import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { timingSafeEqualStr } from "@/lib/crypto";

/**
 * Signed OAuth `state` for calendar-connect flows. The state binds the
 * callback to the business that initiated it and to a nonce echoed in an
 * httpOnly cookie (CSRF), and is HMAC-signed so it cannot be forged or
 * pointed at another tenant. Expires so a leaked URL goes stale quickly.
 */

export interface OAuthStatePayload {
  businessId: string;
  nonce: string;
  /** Unix ms; states older than TTL are rejected. */
  issuedAt: number;
}

const STATE_TTL_MS = 10 * 60_000;

function sign(encoded: string, secret: string): string {
  return createHmac("sha256", secret).update(encoded).digest("base64url");
}

export function createOAuthNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function encodeOAuthState(
  payload: Omit<OAuthStatePayload, "issuedAt">,
  secret: string,
): string {
  const full: OAuthStatePayload = { ...payload, issuedAt: Date.now() };
  const encoded = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

/** Returns the payload only for an authentic, unexpired state. */
export function decodeOAuthState(
  state: string,
  secret: string,
  now = Date.now(),
): OAuthStatePayload | null {
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const encoded = state.slice(0, dot);
  if (!timingSafeEqualStr(state.slice(dot + 1), sign(encoded, secret))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString()) as OAuthStatePayload;
    if (
      typeof payload.businessId !== "string" ||
      typeof payload.nonce !== "string" ||
      typeof payload.issuedAt !== "number" ||
      now - payload.issuedAt > STATE_TTL_MS ||
      payload.issuedAt > now + 60_000
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
