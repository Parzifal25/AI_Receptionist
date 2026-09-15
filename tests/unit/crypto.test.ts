import { describe, expect, it } from "vitest";
import { timingSafeEqualStr } from "@halo/platform/crypto";

describe("timingSafeEqualStr", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqualStr("s3cr3t-token", "s3cr3t-token")).toBe(true);
  });

  it("returns false for different strings", () => {
    expect(timingSafeEqualStr("s3cr3t-token", "wrong-token")).toBe(false);
  });

  it("returns false when one side is empty", () => {
    expect(timingSafeEqualStr("", "s3cr3t-token")).toBe(false);
    expect(timingSafeEqualStr("s3cr3t-token", "")).toBe(false);
  });

  it("tolerates differing lengths without throwing", () => {
    expect(timingSafeEqualStr("short", "a-much-longer-value")).toBe(false);
  });

  it("is sensitive to a single-character difference", () => {
    expect(timingSafeEqualStr("token-a", "token-b")).toBe(false);
  });
});
