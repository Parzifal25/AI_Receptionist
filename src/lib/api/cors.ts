/**
 * CORS handling for the public widget API. Each business can restrict which
 * domains may embed its widget (business_settings.allowed_domains). An empty
 * list allows any origin — the sensible default while installing.
 */

const BASE_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
} as const;

export function corsHeaders(origin: string | null): Record<string, string> {
  return {
    ...BASE_HEADERS,
    "Access-Control-Allow-Origin": origin ?? "*",
  };
}

/** Hostname match, including subdomains: "example.com" allows "app.example.com". */
export function isOriginAllowed(origin: string | null, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true;
  if (!origin) return false;

  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }

  return allowedDomains.some((domain) => {
    const normalized = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!normalized) return false;
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
}

export function preflightResponse(origin: string | null): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}
