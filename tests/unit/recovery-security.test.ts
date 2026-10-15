import { describe, expect, it } from "vitest";
import { recoveryVerdict } from "../../scripts/recovery-security.mjs";

const row = (category: string, value = "baseline") => ({ category, value });
const baseline = ["owner", "acl", "effective", "default"].map((c) => row(c));

describe("restore security acceptance", () => {
  it("rejects successful restore with wider effective access", () => {
    const restored = baseline.map((r) => r.category === "effective" ? row(r.category, "anon:TRUNCATE") : r);
    expect(recoveryVerdict({ restoreStatus: 0, source: baseline, restored })).toEqual({ accepted: false, categories: ["effective"] });
  });
  it.each(["owner", "acl", "effective", "default"])("reports %s differences explicitly", (category) => {
    const restored = baseline.map((r) => r.category === category ? row(category, "different") : r);
    expect(recoveryVerdict({ restoreStatus: 0, source: baseline, restored }).categories).toEqual([category]);
  });
  it("requires both execution success and matching evidence", () => {
    expect(recoveryVerdict({ restoreStatus: 1, source: baseline, restored: baseline }).accepted).toBe(false);
    expect(recoveryVerdict({ restoreStatus: null, source: baseline, restored: baseline }).accepted).toBe(false);
    expect(recoveryVerdict({ restoreStatus: 0, source: null, restored: baseline }).accepted).toBe(false);
    expect(recoveryVerdict({ restoreStatus: 0, source: [], restored: [] }).accepted).toBe(false);
    expect(recoveryVerdict({ restoreStatus: 0, source: [row("acl")], restored: [row("acl")] }).accepted).toBe(false);
    expect(recoveryVerdict({ restoreStatus: 0, source: baseline, restored: baseline }).accepted).toBe(true);
  });
});
