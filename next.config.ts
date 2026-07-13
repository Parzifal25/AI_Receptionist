import type { NextConfig } from "next";

/**
 * Baseline security headers applied to every app route. The public widget
 * API (/api/v1/widget/*) manages its own CORS headers and is intentionally
 * embeddable cross-origin, so these framing/CSP rules — which target the
 * first-party dashboard and marketing pages — do not constrain it.
 */
const securityHeaders = [
  // Force HTTPS for two years, including subdomains. The app is HTTPS-only
  // in production behind Vercel/Supabase.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  // Block MIME sniffing.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // The dashboard must never be framed (clickjacking). frame-ancestors is
  // the modern control; X-Frame-Options is the legacy fallback.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Drop powerful features the app doesn't use.
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next.js injects inline bootstrap/runtime scripts and styles.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      // Supabase auth/data + configured Supabase URL over https/wss.
      "connect-src 'self' https: wss:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Everything except the intentionally cross-origin widget API.
        source: "/((?!api/v1/widget).*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
