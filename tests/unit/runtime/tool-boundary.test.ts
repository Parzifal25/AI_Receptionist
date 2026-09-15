import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WEB_CHAT_PROFILE } from "@halo/runtime/channel-profile";
import { applyStatePatch, emptyConversationState } from "@halo/runtime/conversation-state";
import {
  authorizeIntent,
  executeIntent,
  idempotencyKeyFor,
  selectTools,
  toToolIntent,
} from "@halo/runtime/tools/boundary";
import { BUILTIN_TOOLS, ToolRegistry, type AnyToolExecutor, type ToolExecutionContext } from "@halo/runtime/tools/registry";
import { BUSINESS_A, makeTrusted } from "../../mocks/runtime-fakes";

const execution: ToolExecutionContext = {
  trusted: makeTrusted(),
  business: BUSINESS_A,
  state: emptyConversationState(),
  channel: WEB_CHAT_PROFILE,
  userMessage: "hi",
  now: new Date("2026-09-15T10:00:00Z"),
};

const okExecutor = async () => ({ ok: true, summary: "done" });

function registry(executors: Partial<Record<string, AnyToolExecutor>> = {}) {
  return new ToolRegistry(BUILTIN_TOOLS, executors);
}

describe("tool boundary — selection (Phase 2, WS8)", () => {
  it("offers only tools that are granted AND bound AND channel-allowed", () => {
    const bound = registry({ request_human_handoff: okExecutor });
    const none = selectTools({ registry: bound, grantedToolIds: [], channel: WEB_CHAT_PROFILE, providerSupportsTools: true, execution });
    expect(none.descriptors).toEqual([]);

    const unbound = selectTools({
      registry: bound,
      grantedToolIds: ["save_contact_details"],
      channel: WEB_CHAT_PROFILE,
      providerSupportsTools: true,
      execution,
    });
    expect(unbound.descriptors).toEqual([]);

    const offered = selectTools({
      registry: bound,
      grantedToolIds: ["request_human_handoff", "not_a_tool", "save_contact_details"],
      channel: WEB_CHAT_PROFILE,
      providerSupportsTools: true,
      execution,
    });
    expect(offered.descriptors.map((t) => t.name)).toEqual(["request_human_handoff"]);
    expect(offered.descriptors[0].parameters).toMatchObject({ type: "object" });

    const noTools = selectTools({
      registry: bound,
      grantedToolIds: ["request_human_handoff"],
      channel: { ...WEB_CHAT_PROFILE, allowsToolExecution: false },
      providerSupportsTools: true,
      execution,
    });
    expect(noTools.descriptors).toEqual([]);
  });

  it("downgrades honestly when the provider has no native tools", () => {
    const selected = selectTools({
      registry: registry({ request_human_handoff: okExecutor }),
      grantedToolIds: ["request_human_handoff"],
      channel: WEB_CHAT_PROFILE,
      providerSupportsTools: false,
      execution,
    });
    expect(selected.descriptors).toEqual([]);
    expect(selected.downgraded).toBe(true);
  });

  it("gates tools on conversation state preconditions", () => {
    const selected = selectTools({
      registry: registry({ request_human_handoff: okExecutor }),
      grantedToolIds: ["request_human_handoff"],
      channel: WEB_CHAT_PROFILE,
      providerSupportsTools: true,
      execution: {
        ...execution,
        state: applyStatePatch(emptyConversationState(), {
          escalation: { status: "requested", reason: "explicit_human_request", at: null },
        }),
      },
    });
    expect(selected.descriptors).toEqual([]);
    expect(selected.gated).toEqual(["request_human_handoff"]);
  });
});

describe("tool boundary — intents and authorization", () => {
  const reg = registry({ request_human_handoff: okExecutor, save_contact_details: okExecutor });

  it("turns a valid model call into an intent with a deterministic idempotency key", () => {
    const a = toToolIntent({ call: { id: "c1", name: "save_contact_details", arguments: { phone: "555", name: "Sam" } }, registry: reg, turnId: "t", round: 0 });
    const b = toToolIntent({ call: { id: "c2", name: "save_contact_details", arguments: '{"name":"Sam","phone":"555"}' }, registry: reg, turnId: "t", round: 1 });
    expect("intent" in a && "intent" in b).toBe(true);
    if ("intent" in a && "intent" in b) {
      expect(a.intent.idempotencyKey).toBe(b.intent.idempotencyKey);
      expect(a.intent.correlationId).toBe("t");
    }
    expect(idempotencyKeyFor("t", "x", { a: 1, b: 2 })).toBe(idempotencyKeyFor("t", "x", { b: 2, a: 1 }));
    expect(idempotencyKeyFor("t", "x", { a: 1 })).not.toBe(idempotencyKeyFor("t2", "x", { a: 1 }));
  });

  it("rejects unknown tools and invalid arguments without creating an intent", () => {
    const unknown = toToolIntent({ call: { id: "c", name: "run_sql", arguments: { sql: "drop table" } }, registry: reg, turnId: "t", round: 0 });
    expect("rejected" in unknown && unknown.rejected.rejection).toBe("unknown_tool");

    const garbage = toToolIntent({ call: { id: "c", name: "save_contact_details", arguments: "not json" }, registry: reg, turnId: "t", round: 0 });
    expect("rejected" in garbage && garbage.rejected.rejection).toBe("invalid_arguments");

    const missing = toToolIntent({ call: { id: "c", name: "save_contact_details", arguments: { name: "Sam" } }, registry: reg, turnId: "t", round: 0 });
    expect("rejected" in missing && missing.rejected.rejection).toBe("invalid_arguments");
  });

  it("strips model-supplied identity, destinations and credentials from arguments", () => {
    const converted = toToolIntent({
      call: {
        id: "c",
        name: "save_contact_details",
        arguments: { phone: "555", businessId: "biz-b", url: "https://evil.example", apiKey: "sk-123", table: "leads" },
      },
      registry: reg,
      turnId: "t",
      round: 0,
    });
    expect("intent" in converted).toBe(true);
    if ("intent" in converted) {
      expect(Object.keys(converted.intent.arguments).sort()).toEqual(["email", "name", "note", "phone"]);
    }
  });

  it("authorization: not offered, duplicate, unbound, channel and confirmation are all rejections", () => {
    const converted = toToolIntent({ call: { id: "c", name: "request_human_handoff", arguments: {} }, registry: reg, turnId: "t", round: 0 });
    if (!("intent" in converted)) throw new Error("expected intent");
    const base = {
      intent: converted.intent,
      registry: reg,
      offered: ["request_human_handoff"],
      channel: WEB_CHAT_PROFILE,
      state: emptyConversationState(),
      userMessage: "hi",
      executedKeys: new Set<string>(),
      execution,
    };
    expect(authorizeIntent(base)).toEqual({ allowed: true });
    expect(authorizeIntent({ ...base, offered: [] })).toMatchObject({ allowed: false, reason: "not_granted" });
    expect(authorizeIntent({ ...base, executedKeys: new Set([converted.intent.idempotencyKey]) })).toMatchObject({ allowed: false, reason: "duplicate" });
    expect(authorizeIntent({ ...base, channel: { ...WEB_CHAT_PROFILE, allowsToolExecution: false } })).toMatchObject({ allowed: false, reason: "channel_disallowed" });
    expect(authorizeIntent({ ...base, registry: registry() })).toMatchObject({ allowed: false, reason: "not_bound" });

    const confirmReg = new ToolRegistry(
      { confirm_me: { name: "confirm_me", description: "d", argsSchema: z.object({}), sideEffecting: true, requiresConfirmation: true } },
      { confirm_me: okExecutor },
    );
    const c = toToolIntent({ call: { id: "c", name: "confirm_me", arguments: {} }, registry: confirmReg, turnId: "t", round: 0 });
    if (!("intent" in c)) throw new Error("expected intent");
    const confirmBase = { ...base, intent: c.intent, registry: confirmReg, offered: ["confirm_me"] };
    expect(authorizeIntent(confirmBase)).toMatchObject({ allowed: false, reason: "confirmation_required" });
    const pending = applyStatePatch(emptyConversationState(), {
      pendingConfirmation: { toolName: "confirm_me", arguments: {}, requestedAt: "2026-01-01" },
    });
    expect(authorizeIntent({ ...confirmBase, state: pending, userMessage: "yes please" })).toEqual({ allowed: true });
    expect(authorizeIntent({ ...confirmBase, state: pending, userMessage: "no thanks" })).toMatchObject({ allowed: false });
  });

  it("execution failures become typed results, never exceptions or success claims", async () => {
    const def = reg.definition("request_human_handoff")!;
    const converted = toToolIntent({ call: { id: "c", name: "request_human_handoff", arguments: {} }, registry: reg, turnId: "t", round: 0 });
    if (!("intent" in converted)) throw new Error("expected intent");
    const result = await executeIntent({
      intent: converted.intent,
      definition: def,
      executor: async () => {
        throw new Error("downstream exploded");
      },
      execution,
    });
    expect(result.status).toBe("failed");
    expect(result.claimsPermitted).toEqual([]);
    expect(result.error?.code).toBe("EXECUTION_ERROR");
  });

  it("registry refuses executors for unknown tools (closed set)", () => {
    expect(() => new ToolRegistry(BUILTIN_TOOLS, { fetch_url: okExecutor })).toThrow(/unknown tool/);
  });
});
