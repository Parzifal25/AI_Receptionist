import { lookup as dnsLookup } from "node:dns/promises";

/**
 * SSRF guard for outbound, tenant-configured URLs (workflow webhooks).
 * A URL is allowed only when it is https AND every address its hostname
 * resolves to is publicly routable — loopback, private, link-local (incl.
 * the cloud metadata IP), CGNAT, and unspecified ranges are rejected.
 *
 * Callers should also disable redirect-following on the actual request
 * (`redirect: "manual"`/`"error"`), otherwise a public host can 302 the
 * request into a private one. Residual risk: a DNS answer can change
 * between this check and the fetch (rebinding); pinning the resolved IP
 * with a custom agent closes that if it ever becomes a concern.
 */

type LookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

function isForbiddenIPv4(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return true; // unparsable = reject
  }
  const [a, b] = octets;
  return (
    a === 0 || // 0.0.0.0/8 unspecified
    a === 10 || // 10/8 private
    a === 127 || // 127/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    (a === 169 && b === 254) || // 169.254/16 link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 private
    (a === 192 && b === 168) // 192.168/16 private
  );
}

export function isForbiddenAddress(address: string): boolean {
  const ip = address.trim().toLowerCase();
  if (!ip) return true;

  if (ip.includes(":")) {
    // IPv6. Handle IPv4-mapped (::ffff:a.b.c.d) by checking the embedded v4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return isForbiddenIPv4(mapped[1]);
    if (ip === "::" || ip === "::1") return true; // unspecified / loopback
    const firstGroup = ip.split(":")[0];
    if (/^fe[89ab]/.test(firstGroup)) return true; // fe80::/10 link-local
    if (/^f[cd]/.test(firstGroup)) return true; // fc00::/7 unique-local
    return false;
  }
  return isForbiddenIPv4(ip);
}

/**
 * Parses and validates an outbound webhook URL. Throws with a caller-safe
 * message on any violation; returns the parsed URL when safe.
 */
export async function assertPublicHttpsUrl(
  raw: string,
  lookupImpl: LookupFn = dnsLookup as unknown as LookupFn,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("webhook url is not a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("webhook url must be https");

  const hostname = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookupImpl(hostname, { all: true });
  } catch {
    throw new Error(`webhook host "${hostname}" did not resolve`);
  }
  if (addresses.length === 0) {
    throw new Error(`webhook host "${hostname}" did not resolve`);
  }
  for (const { address } of addresses) {
    if (isForbiddenAddress(address)) {
      throw new Error("webhook host resolves to a private or internal address");
    }
  }
  return url;
}
