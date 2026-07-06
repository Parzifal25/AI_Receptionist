import { describe, expect, it } from "vitest";
import { corsHeaders, isOriginAllowed } from "@/lib/api/cors";

describe("isOriginAllowed", () => {
  it("allows any origin when no domains are configured", () => {
    expect(isOriginAllowed("https://random.site", [])).toBe(true);
    expect(isOriginAllowed(null, [])).toBe(true);
  });

  it("allows exact domain matches", () => {
    expect(isOriginAllowed("https://example.com", ["example.com"])).toBe(true);
  });

  it("allows subdomains", () => {
    expect(isOriginAllowed("https://app.example.com", ["example.com"])).toBe(true);
  });

  it("rejects unrelated domains", () => {
    expect(isOriginAllowed("https://evil.com", ["example.com"])).toBe(false);
  });

  it("rejects suffix-attack domains", () => {
    expect(isOriginAllowed("https://notexample.com", ["example.com"])).toBe(false);
    expect(isOriginAllowed("https://example.com.evil.com", ["example.com"])).toBe(false);
  });

  it("rejects missing origin when domains are restricted", () => {
    expect(isOriginAllowed(null, ["example.com"])).toBe(false);
  });

  it("handles configured domains with protocol or path noise", () => {
    expect(isOriginAllowed("https://example.com", ["https://example.com/"])).toBe(true);
  });

  it("rejects malformed origins", () => {
    expect(isOriginAllowed("not-a-url", ["example.com"])).toBe(false);
  });
});

describe("corsHeaders", () => {
  it("echoes the origin", () => {
    expect(corsHeaders("https://example.com")["Access-Control-Allow-Origin"]).toBe(
      "https://example.com",
    );
  });

  it("falls back to wildcard without origin", () => {
    expect(corsHeaders(null)["Access-Control-Allow-Origin"]).toBe("*");
  });
});
