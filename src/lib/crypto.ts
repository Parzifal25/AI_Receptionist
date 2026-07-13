import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison. Hashing both sides first means the
 * comparison length never leaks the secret's length, and it tolerates
 * differing input lengths (timingSafeEqual itself throws on those).
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
