import { describe, expect, it } from "vitest";
import { assertPublicHttpsUrl, isForbiddenAddress } from "@/lib/ssrf";

describe("isForbiddenAddress", () => {
  it("rejects loopback, private, link-local, CGNAT, and unspecified IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "127.255.255.255",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1",
      "0.0.0.0",
    ]) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.0.1"]) {
      expect(isForbiddenAddress(ip), ip).toBe(false);
    }
  });

  it("handles IPv6 ranges including v4-mapped", () => {
    expect(isForbiddenAddress("::1")).toBe(true);
    expect(isForbiddenAddress("::")).toBe(true);
    expect(isForbiddenAddress("fe80::1")).toBe(true);
    expect(isForbiddenAddress("fc00::1")).toBe(true);
    expect(isForbiddenAddress("fd12:3456::1")).toBe(true);
    expect(isForbiddenAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isForbiddenAddress("::ffff:93.184.216.34")).toBe(false);
    expect(isForbiddenAddress("2606:4700::1111")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isForbiddenAddress("")).toBe(true);
    expect(isForbiddenAddress("999.1.1.1")).toBe(true);
  });
});

describe("assertPublicHttpsUrl", () => {
  const lookup = (ip: string) => async () => [{ address: ip, family: 4 }];

  it("accepts a public https URL", async () => {
    const url = await assertPublicHttpsUrl("https://hooks.example.com/x", lookup("8.8.8.8"));
    expect(url.hostname).toBe("hooks.example.com");
  });

  it("rejects non-https and malformed URLs without resolving", async () => {
    await expect(assertPublicHttpsUrl("http://x.example.com", lookup("8.8.8.8"))).rejects.toThrow(/https/);
    await expect(assertPublicHttpsUrl("not a url", lookup("8.8.8.8"))).rejects.toThrow(/valid URL/);
    await expect(assertPublicHttpsUrl("ftp://x.example.com", lookup("8.8.8.8"))).rejects.toThrow(/https/);
  });

  it("rejects hosts resolving to internal addresses", async () => {
    await expect(
      assertPublicHttpsUrl("https://sneaky.example.com", lookup("10.1.2.3")),
    ).rejects.toThrow(/private or internal/);
  });

  it("rejects any internal address in a multi-answer resolution", async () => {
    const mixed = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "192.168.0.10", family: 4 },
    ];
    await expect(assertPublicHttpsUrl("https://mixed.example.com", mixed)).rejects.toThrow(
      /private or internal/,
    );
  });

  it("rejects unresolvable hosts", async () => {
    const failing = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertPublicHttpsUrl("https://nope.invalid", failing)).rejects.toThrow(
      /did not resolve/,
    );
  });

  it("rejects literal private IPs (v4 and bracketed v6)", async () => {
    const literal = async (host: string) => [{ address: host, family: host.includes(":") ? 6 : 4 }];
    await expect(assertPublicHttpsUrl("https://127.0.0.1/x", literal)).rejects.toThrow(
      /private or internal/,
    );
    await expect(assertPublicHttpsUrl("https://[::1]/x", literal)).rejects.toThrow(
      /private or internal/,
    );
  });
});
