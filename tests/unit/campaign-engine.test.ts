import { describe, it, expect, vi } from "vitest";
import { CampaignEngine, inCallingWindow, campaignPolicySchema, type CampaignStore, type ClaimedContact } from "@halo/campaigns/engine";
const contact: ClaimedContact = { id: "contact", businessId: "education", campaignId: "enrollment", customerId: "student",
  agentId: "advisor", agentVersionId: "published-3", from: "+15550000001", to: "+15550000002", attempt: 1 };
function setup() {
  const store: CampaignStore = { claim: vi.fn(async () => [contact]), authorize: vi.fn(async () => true), settle: vi.fn(async () => {}) };
  const dialer = { dial: vi.fn(async () => ({ status: "accepted" as const, providerCallId: "call-1" })) };
  return { store, dialer, engine: new CampaignEngine(store, dialer) };
}
describe("campaign dispatch", () => {
  it("uses a pinned agent version and stable attempt key", async () => {
    const { engine, dialer } = setup();
    expect(await engine.dispatch("education", "enrollment")).toEqual({ claimed: 1, accepted: 1, uncertain: 0 });
    expect(dialer.dial).toHaveBeenCalledWith(expect.objectContaining({ agentVersionId: "published-3", idempotencyKey: "contact:1" }));
  });
  it("does not dial a newly suppressed or paused contact", async () => {
    const { engine, store, dialer } = setup();
    vi.mocked(store.authorize).mockResolvedValue(false);
    await engine.dispatch("education", "enrollment");
    expect(dialer.dial).not.toHaveBeenCalled();
    expect(store.settle).toHaveBeenCalledWith(contact, { status: "rejected", retryable: false });
  });
  it("does not retry an uncertain network outcome", async () => {
    const { engine, store, dialer } = setup();
    dialer.dial.mockRejectedValue(new Error("timeout"));
    expect((await engine.dispatch("education", "enrollment")).uncertain).toBe(1);
    expect(dialer.dial).toHaveBeenCalledTimes(1);
    expect(store.settle).toHaveBeenCalledWith(contact, { status: "unknown" });
  });
  it("rejects tenant mismatch before touching a provider", async () => {
    const { engine, dialer } = setup();
    await expect(engine.dispatch("support", "enrollment")).rejects.toThrow("scope mismatch");
    expect(dialer.dial).not.toHaveBeenCalled();
  });
  it("uses local time including DST and excludes the end boundary", () => {
    const policy = campaignPolicySchema.parse({ timezone: "America/New_York", weekdays: [1], startMinute: 540, endMinute: 1020, maxAttempts: 3, retryDelaySeconds: 3600 });
    expect(inCallingWindow(policy, new Date("2026-09-28T13:00:00Z"))).toBe(true);
    expect(inCallingWindow(policy, new Date("2026-09-28T21:00:00Z"))).toBe(false);
    expect(inCallingWindow(policy, new Date("2026-01-05T13:00:00Z"))).toBe(false);
    expect(inCallingWindow(policy, new Date("2026-01-05T14:00:00Z"))).toBe(true);
  });
});
