import { describe, expect, it } from "vitest";
import { validateRecoveryTarget } from "../../scripts/recovery-local.mjs";

describe("local recovery targeting guard", () => {
  it("accepts only the explicitly opted-in disposable fixture", () => {
    expect(() => validateRecoveryTarget("halo-gates-disposable-20261013", "halo_check_integrations", "halo_check_restore_one", { HALO_DISPOSABLE_DATABASE: "1" })).not.toThrow();
  });
  it.each([
    ["production", "halo_check_integrations", "halo_check_restore_one", "1"],
    ["halo-gates-disposable-20261013", "postgres", "halo_check_restore_one", "1"],
    ["halo-gates-disposable-20261013", "halo_check_integrations", "halo_check_integrations", "1"],
    ["halo-gates-disposable-20261013", "halo_check_integrations", "halo_check_restore_one;drop database postgres", "1"],
    ["halo-gates-disposable-20261013", "halo_check_integrations", "halo_check_restore_one", "0"],
  ])("rejects unsafe targets without invoking Docker", (container, source, target, optIn) => {
    expect(() => validateRecoveryTarget(container, source, target, { HALO_DISPOSABLE_DATABASE: optIn })).toThrow(/Recovery requires/);
  });
});
