import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "@/lib/safe-redirect";

describe("safeRedirectPath", () => {
  it("allows a normal path-absolute value", () => {
    expect(safeRedirectPath("/dashboard/leads")).toBe("/dashboard/leads");
  });

  it("falls back for non-string input", () => {
    expect(safeRedirectPath(null)).toBe("/dashboard");
    expect(safeRedirectPath(undefined)).toBe("/dashboard");
    expect(safeRedirectPath(42)).toBe("/dashboard");
  });

  it("falls back for values that don't start with /", () => {
    expect(safeRedirectPath("dashboard")).toBe("/dashboard");
    expect(safeRedirectPath("https://evil.com")).toBe("/dashboard");
  });

  it("rejects protocol-relative URLs", () => {
    expect(safeRedirectPath("//evil.com")).toBe("/dashboard");
    expect(safeRedirectPath("//evil.com/phish")).toBe("/dashboard");
  });

  it("rejects backslash variants", () => {
    expect(safeRedirectPath("/\\evil.com")).toBe("/dashboard");
  });

  it("respects a custom fallback", () => {
    expect(safeRedirectPath("//evil.com", "/login")).toBe("/login");
  });
});
