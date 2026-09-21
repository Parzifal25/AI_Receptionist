import { describe, expect, it } from "vitest";
import {
  authorizeConcession,
  availableConcessions,
  approvableConcessions,
  disclosableQuotes,
  emptyNegotiationSnapshot,
  shouldEscalate,
} from "@halo/negotiation/authorization";
import { emptyNegotiationPolicy, parseNegotiationPolicy } from "@halo/negotiation/policy";
import { concessionExecutor } from "@halo/negotiation/tool";
import type { ToolExecutionContext } from "@halo/runtime/tools/registry";

/**
 * Phase 4 — the line between conversational strategy and business
 * authorization. The model may negotiate; only this may say yes.
 */

const CTX = {} as ToolExecutionContext;

function policyOf(overrides: Record<string, unknown> = {}) {
  const parsed = parseNegotiationPolicy({
    version: "test-1",
    language: "te-IN",
    currency: "INR",
    priceDisclosure: "none",
    concessions: [
      {
        id: "standard_offer",
        label: { "te-IN": "సాధారణ ఆఫర్" },
        type: "discount_percent",
        value: 5,
        requiresApproval: false,
        script: { "te-IN": "మేము 5% తగ్గింపు ఇవ్వగలము." },
        conditions: [{ field: "property_type", in: ["independent_house"] }],
      },
      {
        id: "unset_offer",
        label: { "te-IN": "ఇంకా నిర్ణయించలేదు" },
        type: "discount_percent",
        value: null,
        requiresApproval: false,
        script: { "te-IN": "placeholder" },
      },
      {
        id: "manager_offer",
        label: { "te-IN": "మేనేజర్ ఆఫర్" },
        type: "discount_percent",
        value: 8,
        requiresApproval: true,
        script: { "te-IN": "placeholder" },
      },
    ],
    escalation: { requestsBeforeHuman: 2, escalateOnUnlistedRequest: true, humanApprovalAbovePercent: null },
    prohibitedPromises: ["ఎటువంటి సబ్సిడీ హామీ ఇవ్వకండి"],
    ...overrides,
  });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.policy;
}

describe("negotiation policy", () => {
  it("authorizes nothing by default — an empty policy is a safe policy", () => {
    const policy = emptyNegotiationPolicy("te-IN");
    const snapshot = emptyNegotiationSnapshot();
    expect(availableConcessions(policy, snapshot)).toEqual([]);
    expect(disclosableQuotes(policy)).toEqual([]);
    expect(policy.priceDisclosure).toBe("none");
    expect(policy.floors).toEqual({ minAmount: null, maxDiscountPercent: null });
  });

  it("treats a null value as UNSET, never as the agent's discretion", () => {
    const decision = authorizeConcession({
      policy: policyOf(),
      snapshot: emptyNegotiationSnapshot(),
      concessionId: "unset_offer",
    });
    expect(decision).toMatchObject({ allowed: false, reason: "no_authorized_value" });
  });

  it("refuses a concession whose qualification conditions have not been established", () => {
    const decision = authorizeConcession({
      policy: policyOf(),
      snapshot: emptyNegotiationSnapshot(),
      concessionId: "standard_offer",
    });
    expect(decision).toMatchObject({ allowed: false, reason: "condition_unmet" });
  });

  it("authorizes it once the condition holds, and returns the tenant's exact words", () => {
    const snapshot = { ...emptyNegotiationSnapshot(), fields: { property_type: "independent_house" } };
    const decision = authorizeConcession({ policy: policyOf(), snapshot, concessionId: "standard_offer" });
    if (!decision.allowed) throw new Error(decision.reason);
    expect(decision.offer).toMatchObject({ id: "standard_offer", value: 5, script: "మేము 5% తగ్గింపు ఇవ్వగలము." });
  });

  it("routes approval-gated concessions to a person rather than granting them", () => {
    const snapshot = emptyNegotiationSnapshot();
    const policy = policyOf();
    expect(authorizeConcession({ policy, snapshot, concessionId: "manager_offer" })).toMatchObject({
      allowed: false,
      reason: "needs_human_approval",
    });
    expect(approvableConcessions(policy, snapshot)).toContain("manager_offer");
  });

  it("refuses anything the business never listed", () => {
    expect(
      authorizeConcession({ policy: policyOf(), snapshot: emptyNegotiationSnapshot(), concessionId: "twenty_percent" }),
    ).toMatchObject({ allowed: false, reason: "unknown" });
  });

  it("enforces a per-conversation offer budget across turns", () => {
    const policy = policyOf();
    const snapshot = { ...emptyNegotiationSnapshot(), fields: { property_type: "independent_house" }, offered: { standard_offer: 1 } };
    expect(authorizeConcession({ policy, snapshot, concessionId: "standard_offer" })).toMatchObject({
      allowed: false,
      reason: "already_offered",
    });
  });

  it("refuses to load a policy that contradicts its own floor", () => {
    const parsed = parseNegotiationPolicy({
      version: "bad",
      language: "en-IN",
      floors: { minAmount: null, maxDiscountPercent: 5 },
      concessions: [
        {
          id: "too_big",
          label: { "en-IN": "big" },
          type: "discount_percent",
          value: 20,
          requiresApproval: false,
          script: { "en-IN": "twenty percent off" },
        },
      ],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected refusal");
    expect(parsed.errors.join(" ")).toContain("exceeds the configured floor");
  });

  it("refuses to disclose prices it has no verified figure for", () => {
    const parsed = parseNegotiationPolicy({ version: "x", language: "en-IN", priceDisclosure: "exact", quotes: [] });
    expect(parsed.ok).toBe(false);
    const withNull = parseNegotiationPolicy({
      version: "x",
      language: "en-IN",
      priceDisclosure: "exact",
      quotes: [{ id: "per_kw", label: { "en-IN": "Per kW" }, amount: null, unit: "kw" }],
    });
    expect(withNull.ok).toBe(false);
  });

  it("escalates once the customer has pushed past what nothing authorizes", () => {
    const policy = policyOf();
    expect(shouldEscalate(policy, { ...emptyNegotiationSnapshot(), requests: 1 })).toBe(false);
    expect(shouldEscalate(policy, { ...emptyNegotiationSnapshot(), requests: 2 })).toBe(true);
    expect(shouldEscalate(policy, emptyNegotiationSnapshot(), true)).toBe(true);
  });
});

describe("offer_concession executor", () => {
  function build(fields: Record<string, string> = {}) {
    const policy = policyOf();
    let snapshot = { ...emptyNegotiationSnapshot(), fields };
    const executor = concessionExecutor({
      policy,
      snapshot: () => snapshot,
      recordOffer: (id) => {
        snapshot = { ...snapshot, offered: { ...snapshot.offered, [id]: (snapshot.offered[id] ?? 0) + 1 } };
      },
    });
    return { executor, snapshot: () => snapshot };
  }

  it("permits the claim only when the policy authorized the offer", async () => {
    const { executor } = build({ property_type: "independent_house" });
    const ok = await executor({ concessionId: "standard_offer" }, CTX);
    expect(ok.ok).toBe(true);
    expect(ok.claimsPermitted).toEqual(["concession.offered"]);
    expect(ok.summary).toContain("మేము 5% తగ్గింపు ఇవ్వగలము.");
  });

  it("refuses an unauthorized offer and permits no claim about it", async () => {
    const { executor } = build();
    const denied = await executor({ concessionId: "manager_offer" }, CTX);
    expect(denied.ok).toBe(false);
    expect(denied.claimsPermitted).toEqual([]);
    expect(denied.escalation?.reason).toBe("unsupported_request");
  });

  it("refuses an id the model invented", async () => {
    const { executor } = build({ property_type: "independent_house" });
    const denied = await executor({ concessionId: "fifty_percent_off" }, CTX);
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("unknown");
  });

  it("enforces the budget even when the model forgets it already offered", async () => {
    const { executor } = build({ property_type: "independent_house" });
    expect((await executor({ concessionId: "standard_offer" }, CTX)).ok).toBe(true);
    const second = await executor({ concessionId: "standard_offer" }, CTX);
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe("already_offered");
  });
});
