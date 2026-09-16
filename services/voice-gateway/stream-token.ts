import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived capability token binding a media socket to the call identity
 * the (already signature-verified) telephony webhook reported.
 *
 * The media WebSocket is a public endpoint: a provider cannot sign its
 * upgrade the way it signs a webhook. So the gateway mints a token during the
 * verified webhook and requires it — bound to the provider call id AND the
 * numbers — when the stream starts. A forged `start` frame with tampered
 * parameters fails verification, so the media path cannot be used to open a
 * session against another tenant's number.
 */

export interface StreamTokenClaims {
  providerCallId: string;
  from: string;
  to: string;
}

const SEPARATOR = ".";

export function mintStreamToken(secret: string, claims: StreamTokenClaims, ttlMs: number, now = Date.now()): string {
  const expiresAt = now + ttlMs;
  return `${expiresAt}${SEPARATOR}${sign(secret, claims, expiresAt)}`;
}

export type StreamTokenVerification =
  | { ok: true }
  | { ok: false; reason: "malformed" | "expired" | "invalid" };

export function verifyStreamToken(
  secret: string,
  token: string,
  claims: StreamTokenClaims,
  now = Date.now(),
): StreamTokenVerification {
  const [expiresRaw, signature] = token.split(SEPARATOR);
  const expiresAt = Number.parseInt(expiresRaw ?? "", 10);
  if (!Number.isFinite(expiresAt) || !signature) return { ok: false, reason: "malformed" };
  if (expiresAt < now) return { ok: false, reason: "expired" };
  const expected = Buffer.from(sign(secret, claims, expiresAt), "hex");
  const given = Buffer.from(/^[0-9a-f]+$/i.test(signature) ? signature : "", "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "invalid" };
  return { ok: true };
}

function sign(secret: string, claims: StreamTokenClaims, expiresAt: number): string {
  return createHmac("sha256", secret)
    .update(`${claims.providerCallId}\n${claims.from}\n${claims.to}\n${expiresAt}`)
    .digest("hex");
}
