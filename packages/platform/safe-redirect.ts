/**
 * Validates a user-supplied "next" path before redirecting to it. Only
 * same-origin, path-absolute values are allowed — rejects protocol-relative
 * URLs ("//evil.com", which browsers resolve to https://evil.com) and
 * backslash variants ("/\evil.com", normalized to "//evil.com" by some
 * browsers), which a bare `startsWith("/")` check would miss.
 */
export function safeRedirectPath(next: unknown, fallback = "/dashboard"): string {
  if (typeof next !== "string") return fallback;
  // The URL parser removes TAB/CR/LF before resolving a URL; /<TAB>/host
  // would otherwise pass the prefix check and become an external redirect.
  if (/[\u0000-\u0020\u007f]/.test(next)) return fallback;
  if (!next.startsWith("/")) return fallback;
  if (next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
