import { describe, expect, it } from "vitest";
import { RuntimeCancelledError } from "@halo/runtime/cancellation";
import { BUILTIN_TOOLS, ToolRegistry, type AnyToolExecutor } from "@halo/runtime/tools/registry";
import {
  AUDIT_UNAVAILABLE_CODE,
  InMemoryToolExecutionAuditStore,
  ToolAuditTrail,
  boundedId,
  type ToolAuditEntry,
  type ToolAuditRef,
  type ToolExecutionAuditStore,
} from "@halo/runtime/tools/audit";
import type { ToolRejectionReason } from "@halo/runtime/contracts";
import { makeAgent, makeInput, makeRuntime, makeTrusted, reply, ScriptedLLM } from "../mocks/runtime-fakes";

/**
 * D7 — tool-execution audit, exercised through the real AgentRuntime tool
 * boundary (packages/runtime/agent-runtime.ts → tools/audit.ts). The store is
 * the in-memory implementation that mirrors the database invariants; a spy
 * wrapper only observes or injects failures, it never replaces the runtime.
 */

const ALLOWED_RECORD_KEYS = [
  "agentId", "agentVersionId", "businessId", "channelId", "conversationId", "correlationId", "errorCode", "finishedAt",
  "id", "idempotencyKey", "intentId", "rejectionReason", "requestedAt", "round", "sideEffecting", "startedAt",
  "status", "toolName", "turnId",
].sort();

function grantedAgent(tools: string[], businessId = "biz-a") {
  const agent = makeAgent();
  agent.config.tools.grantedToolIds = tools;
  agent.business = { ...agent.business, id: businessId };
  return agent;
}

function registryWith(executors: Partial<Record<string, AnyToolExecutor>>) {
  return new ToolRegistry(BUILTIN_TOOLS, executors);
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, name, arguments: args };
}

function toolTurn(calls: ReturnType<typeof toolCall>[], narration = "Done.") {
  return new ScriptedLLM([reply("", { toolCalls: calls, finishReason: "tool_calls" }), reply(narration)]);
}

/** Wraps the real in-memory store; can inject failures per stage. */
class SpyAuditStore implements ToolExecutionAuditStore {
  readonly inner = new InMemoryToolExecutionAuditStore();
  calls: string[] = [];
  failRejected = false;
  failStarted = false;
  failFinished = false;

  async recordRejected(entry: ToolAuditEntry, reason: ToolRejectionReason, at: string) {
    this.calls.push(`rejected:${reason}`);
    if (this.failRejected) throw new Error("db down");
    return this.inner.recordRejected(entry, reason, at);
  }
  async recordStarted(entry: ToolAuditEntry, startedAt: string) {
    this.calls.push(`started:${entry.toolName}`);
    if (this.failStarted) throw new Error("db down");
    return this.inner.recordStarted(entry, startedAt);
  }
  async recordFinished(ref: ToolAuditRef, outcome: { status: "succeeded" | "failed"; errorCode: string | null; finishedAt: string }) {
    this.calls.push(`finished:${outcome.status}`);
    if (this.failFinished) throw new Error("db down");
    return this.inner.recordFinished(ref, outcome);
  }
}

describe("D7 tool-execution audit at the runtime tool boundary", () => {
  it("records a successful execution: started before the executor runs, then succeeded", async () => {
    const store = new SpyAuditStore();
    let seenDuringExecution: string[] = [];
    const { runtime } = makeRuntime({
      llm: toolTurn([toolCall("c1", "save_contact_details", { phone: "+15550001234" })]),
      toolAudit: store,
      registry: registryWith({
        save_contact_details: async () => {
          seenDuringExecution = store.inner.forTenant("biz-a").map((r) => r.status);
          return { ok: true, summary: "saved" };
        },
      }),
    });
    const output = await runtime.run(makeInput({ agent: grantedAgent(["save_contact_details"]) }));

    expect(seenDuringExecution).toEqual(["started"]);
    expect(output.toolResults[0]?.status).toBe("succeeded");
    const [row] = store.inner.forTenant("biz-a");
    expect(row).toMatchObject({
      businessId: "biz-a",
      conversationId: "conv-1",
      agentId: "agent-a",
      agentVersionId: "av-a-1",
      turnId: "turn-1",
      round: 0,
      intentId: "c1",
      toolName: "save_contact_details",
      sideEffecting: true,
      status: "succeeded",
      rejectionReason: null,
      errorCode: null,
    });
    expect(row?.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
    expect(row?.channelId).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(row?.correlationId).toEqual(expect.any(String));
    expect(row?.startedAt).toEqual(expect.any(String));
    expect(row?.finishedAt).toEqual(expect.any(String));
    expect(store.calls).toEqual(["started:save_contact_details", "finished:succeeded"]);
  });

  it("records an executor-reported failure without rewriting the tool's own result", async () => {
    const store = new InMemoryToolExecutionAuditStore();
    const { runtime } = makeRuntime({
      llm: toolTurn([toolCall("c1", "save_contact_details", { phone: "+15550001234" })]),
      toolAudit: store,
      registry: registryWith({
        save_contact_details: async () => ({ ok: false, summary: "Lead store refused.", error: { code: "LEAD_WRITE_FAILED", message: "constraint x" } }),
      }),
    });
    const output = await runtime.run(makeInput({ agent: grantedAgent(["save_contact_details"]) }));

    expect(output.toolResults[0]).toMatchObject({ status: "failed", summary: "Lead store refused.", error: { code: "LEAD_WRITE_FAILED", message: "constraint x" } });
    expect(store.forTenant("biz-a")).toMatchObject([{ status: "failed", errorCode: "LEAD_WRITE_FAILED" }]);
  });

  it("records a thrown executor as EXECUTION_ERROR and keeps the existing failure semantics", async () => {
    const store = new InMemoryToolExecutionAuditStore();
    let invocations = 0;
    const { runtime } = makeRuntime({
      llm: toolTurn([toolCall("c1", "save_contact_details", { phone: "+15550001234" })], "It did not go through."),
      toolAudit: store,
      registry: registryWith({
        save_contact_details: async () => {
          invocations += 1;
          throw new Error("socket hang up while writing +15550001234");
        },
      }),
    });
    const output = await runtime.run(makeInput({ agent: grantedAgent(["save_contact_details"]) }));

    expect(invocations).toBe(1);
    expect(output.toolResults[0]).toMatchObject({ status: "failed", error: { code: "EXECUTION_ERROR" } });
    const [row] = store.forTenant("biz-a");
    expect(row).toMatchObject({ status: "failed", errorCode: "EXECUTION_ERROR" });
    expect(JSON.stringify(row)).not.toContain("socket hang up");
  });

  it("stores only an identifier-shaped error code; free text becomes UNCLASSIFIED", async () => {
    const store = new InMemoryToolExecutionAuditStore();
    const { runtime } = makeRuntime({
      llm: toolTurn([toolCall("c1", "save_contact_details", { phone: "+15550001234" })]),
      toolAudit: store,
      registry: registryWith({
        save_contact_details: async () => ({ ok: false, summary: "no", error: { code: "phone +15550001234 invalid", message: "x" } }),
      }),
    });
    await runtime.run(makeInput({ agent: grantedAgent(["save_contact_details"]) }));
    expect(store.forTenant("biz-a")[0]?.errorCode).toBe("UNCLASSIFIED");
  });

  it("records authorization denials and pre-intent rejections without executing anything", async () => {
    const store = new InMemoryToolExecutionAuditStore();
    let invocations = 0;
    const executor: AnyToolExecutor = async () => {
      invocations += 1;
      return { ok: true, summary: "ran" };
    };
    const { runtime } = makeRuntime({
      llm: toolTurn([
        toolCall("c1", "offer_concession", { concessionId: "free_survey" }), // bound but not granted
        toolCall("c2", "drop_all_tables", { please: true }), // invented tool
        toolCall("c3", "save_contact_details", { note: "no contact" }), // invalid arguments
      ]),
      toolAudit: store,
      registry: registryWith({ offer_concession: executor, save_contact_details: executor }),
    });
    await runtime.run(makeInput({ agent: grantedAgent(["save_contact_details"]) }));

    expect(invocations).toBe(0);
    const rows = store.forTenant("biz-a");
    expect(rows.map((r) => [r.intentId, r.status, r.rejectionReason, r.toolName])).toEqual([
      ["c1", "rejected", "not_granted", "offer_concession"],
      ["c2", "rejected", "unknown_tool", null],
      ["c3", "rejected", "invalid_arguments", "save_contact_details"],
    ]);
    expect(rows.every((r) => r.startedAt === null && r.finishedAt !== null)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("drop_all_tables");
  });

  it("records calls beyond the per-round budget as budget_exhausted", async () => {
    const store = new InMemoryToolExecutionAuditStore();
    const calls = [0, 1, 2, 3].map((i) => toolCall(`c${i}`, "save_contact_details", { phone: `+1555000000${i}` }));
    const { runtime } = makeRuntime({
      llm: toolTurn(calls),
      toolAudit: store,
      registry: registryWith({ save_contact_details: async () => ({ ok: true, summary: "saved" }) }),
    });
    await runtime.run(makeInput({ agent: grantedAgent(["save_contact_details"]) }));
    const rows = store.forTenant("biz-a");
    expect(rows.filter((r) => r.status === "succeeded")).toHaveLength(3);
    expect(rows.filter((r) => r.rejectionReason === "budget_exhausted").map((r) => r.intentId)).toEqual(["c3"]);
  });

  it("takes the tenant from trusted runtime state, never from tool arguments", async () => {
    const store = new InMemoryToolExecutionAuditStore();
    const { runtime } = makeRuntime({
      llm: toolTurn([toolCall("c1", "save_contact_details", { phone: "+15550001234", businessId: "biz-b", tenant: "biz-b" })]),
      toolAudit: store,
      registry: registryWith({ save_contact_details: async () => ({ ok: true, summary: "saved" }) }),
    });
    await runtime.run(makeInput({ agent: grantedAgent(["save_contact_details"]) }));
    expect(store.forTenant("biz-b")).toHaveLength(0);
    const rows = store.forTenant("biz-a");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("biz-b");
  });

  it("keeps each tenant's audit records separate", async () => {
    const store = new InMemoryToolExecutionAuditStore();
    for (const businessId of ["biz-a", "biz-b"]) {
      const { runtime } = makeRuntime({
        llm: toolTurn([toolCall("c1", "save_contact_details", { phone: "+15550001234" })]),
        toolAudit: store,
        registry: registryWith({ save_contact_details: async () => ({ ok: true, summary: "saved" }) }),
      });
      await runtime.run(makeInput({ agent: grantedAgent(["save_contact_details"], businessId), trusted: makeTrusted({ businessId }) }));
    }
    expect(store.forTenant("biz-a").map((r) => r.businessId)).toEqual(["biz-a"]);
    expect(store.forTenant("biz-b").map((r) => r.businessId)).toEqual(["biz-b"]);
    await expect(store.recordFinished({ id: store.forTenant("biz-a")[0]!.id, businessId: "biz-b" }, { status: "failed", errorCode: null, finishedAt: new Date().toISOString() }))
      .rejects.toThrow(/tenant/);
  });

  it("never stores tool arguments, results, summaries or contact details", async () => {
    const store = new InMemoryToolExecutionAuditStore();
    const { runtime } = makeRuntime({
      llm: toolTurn([toolCall("c1", "save_contact_details", { name: "Ravi Kumar", phone: "+15550001234", email: "ravi@example.com", note: "secret-token-xyz" })]),
      toolAudit: store,
      registry: registryWith({ save_contact_details: async () => ({ ok: true, summary: "Saved Ravi Kumar", data: { leadId: "lead-9" } }) }),
    });
    await runtime.run(makeInput({ agent: grantedAgent(["save_contact_details"]) }));
    const rows = store.forTenant("biz-a");
    const serialized = JSON.stringify(rows);
    for (const sensitive of ["Ravi", "+15550001234", "ravi@example.com", "secret-token-xyz", "lead-9", "Saved"]) {
      expect(serialized).not.toContain(sensitive);
    }
    expect(Object.keys(rows[0]!).sort()).toEqual(ALLOWED_RECORD_KEYS);
  });

  it("handles a missing correlation id: the record keeps null rather than inventing one", async () => {
    expect(boundedId(undefined, 100)).toBeNull();
    expect(boundedId("   ", 100)).toBeNull();
    const store = new InMemoryToolExecutionAuditStore();
    const trail = new ToolAuditTrail(
      store,
      { businessId: "biz-a", conversationId: "conv-1", agentId: "agent-a", agentVersionId: "av-a-1", channelId: "web-chat", turnId: "turn-1", correlationId: null },
      () => {},
      () => "2026-10-15T00:00:00.000Z",
    );
    await trail.rejected(trail.entry({ round: 0, intentId: "c1", toolName: null, idempotencyKey: null, sideEffecting: null }), "unknown_tool");
    expect(store.forTenant("biz-a")[0]?.correlationId).toBeNull();
  });

  it("runs a repeated identical intent once and records the repeat as a duplicate rejection", async () => {
    const store = new InMemoryToolExecutionAuditStore();
    let invocations = 0;
    const args = { phone: "+15550001234" };
    const { runtime } = makeRuntime({
      llm: toolTurn([toolCall("c1", "save_contact_details", args), toolCall("c2", "save_contact_details", args)]),
      toolAudit: store,
      registry: registryWith({
        save_contact_details: async () => {
          invocations += 1;
          return { ok: true, summary: "saved" };
        },
      }),
    });
    await runtime.run(makeInput({ agent: grantedAgent(["save_contact_details"]) }));
    expect(invocations).toBe(1);
    expect(store.forTenant("biz-a").map((r) => [r.intentId, r.status, r.rejectionReason])).toEqual([
      ["c1", "succeeded", null],
      ["c2", "rejected", "duplicate"],
    ]);
  });

  it("the store refuses a second execution record for the same idempotency key and turn", async () => {
    const store = new InMemoryToolExecutionAuditStore();
    const entry: ToolAuditEntry = {
      businessId: "biz-a", conversationId: "conv-1", agentId: "agent-a", agentVersionId: "av-a-1", channelId: "web-chat",
      turnId: "turn-1", correlationId: null, round: 0, intentId: "c1", toolName: "save_contact_details",
      idempotencyKey: "0".repeat(32), sideEffecting: true, requestedAt: "2026-10-15T00:00:00.000Z",
    };
    const ref = await store.recordStarted(entry, entry.requestedAt);
    await expect(store.recordStarted({ ...entry, intentId: "c2" }, entry.requestedAt)).rejects.toThrow(/duplicate/);
    await store.recordFinished(ref, { status: "succeeded", errorCode: null, finishedAt: entry.requestedAt });
    await expect(store.recordFinished(ref, { status: "failed", errorCode: null, finishedAt: entry.requestedAt })).rejects.toThrow(/final/);
  });

  describe("audit-write failure policy", () => {
    it("fails a side-effecting tool closed when its pre-execution record cannot be written", async () => {
      const store = new SpyAuditStore();
      store.failStarted = true;
      let invocations = 0;
      const { runtime, sink } = makeRuntime({
        llm: toolTurn([toolCall("c1", "save_contact_details", { phone: "+15550001234" })], "It did not go through."),
        toolAudit: store,
        registry: registryWith({
          save_contact_details: async () => {
            invocations += 1;
            return { ok: true, summary: "saved" };
          },
        }),
      });
      const output = await runtime.run(makeInput({ agent: grantedAgent(["save_contact_details"]) }));

      expect(invocations).toBe(0);
      expect(output.toolResults[0]).toMatchObject({ status: "failed", claimsPermitted: [], error: { code: AUDIT_UNAVAILABLE_CODE } });
      expect(output.actions.filter((a) => a.source === "tool").map((a) => a.status)).toEqual(["failed"]);
      expect(sink.events.find((e) => e.type === "tool.audit_failed")?.data).toMatchObject({ stage: "started", name: "save_contact_details" });
    });

    it("fails closed when no audit store is configured at all", async () => {
      let invocations = 0;
      const { runtime, sink } = makeRuntime({
        llm: toolTurn([toolCall("c1", "save_contact_details", { phone: "+15550001234" })], "It did not go through."),
        toolAudit: undefined,
        registry: registryWith({
          save_contact_details: async () => {
            invocations += 1;
            return { ok: true, summary: "saved" };
          },
        }),
      });
      const output = await runtime.run(makeInput({ agent: grantedAgent(["save_contact_details"]) }));
      expect(invocations).toBe(0);
      expect(output.toolResults[0]?.error?.code).toBe(AUDIT_UNAVAILABLE_CODE);
      expect(sink.events.some((e) => e.type === "tool.audit_failed" && e.data.stage === "not_configured")).toBe(true);
    });

    it("still runs a non-side-effecting handoff when its record cannot be written", async () => {
      const store = new SpyAuditStore();
      store.failStarted = true;
      let invocations = 0;
      const { runtime } = makeRuntime({
        llm: toolTurn([toolCall("c1", "request_human_handoff", { reason: "caller asked for a person" })], "Someone will call you."),
        toolAudit: store,
        registry: registryWith({
          request_human_handoff: async () => {
            invocations += 1;
            return { ok: true, summary: "Handoff recorded.", claimsPermitted: ["handoff"] };
          },
        }),
      });
      const output = await runtime.run(makeInput({ agent: grantedAgent(["request_human_handoff"]) }));
      expect(invocations).toBe(1);
      expect(output.toolResults[0]?.status).toBe("succeeded");
    });

    it("never re-runs an action whose finalize write failed; the record stays started", async () => {
      const store = new SpyAuditStore();
      store.failFinished = true;
      let invocations = 0;
      const { runtime, sink } = makeRuntime({
        llm: toolTurn([toolCall("c1", "save_contact_details", { phone: "+15550001234" })]),
        toolAudit: store,
        registry: registryWith({
          save_contact_details: async () => {
            invocations += 1;
            return { ok: true, summary: "saved" };
          },
        }),
      });
      const output = await runtime.run(makeInput({ agent: grantedAgent(["save_contact_details"]) }));
      expect(invocations).toBe(1);
      expect(output.toolResults[0]?.status).toBe("succeeded");
      expect(store.inner.forTenant("biz-a").map((r) => r.status)).toEqual(["started"]);
      expect(store.calls.filter((c) => c.startsWith("finished"))).toHaveLength(1);
      expect(sink.events.find((e) => e.type === "tool.audit_failed")?.data).toMatchObject({ stage: "finished" });
    });

    it("a failed rejection record never changes the rejection or the turn", async () => {
      const store = new SpyAuditStore();
      store.failRejected = true;
      const { runtime } = makeRuntime({
        llm: toolTurn([toolCall("c1", "drop_all_tables", {})], "I can't do that."),
        toolAudit: store,
        registry: registryWith({ save_contact_details: async () => ({ ok: true, summary: "saved" }) }),
      });
      const output = await runtime.run(makeInput({ agent: grantedAgent(["save_contact_details"]) }));
      expect(output.toolResults[0]).toMatchObject({ status: "rejected", rejection: "unknown_tool" });
      expect(output.reply).toBe("I can't do that.");
    });
  });

  it("a turn cancelled before any work writes no audit records", async () => {
    const store = new InMemoryToolExecutionAuditStore();
    const controller = new AbortController();
    controller.abort();
    const { runtime } = makeRuntime({
      llm: toolTurn([toolCall("c1", "save_contact_details", { phone: "+15550001234" })]),
      toolAudit: store,
      registry: registryWith({ save_contact_details: async () => ({ ok: true, summary: "saved" }) }),
    });
    await expect(runtime.run(makeInput({ agent: grantedAgent(["save_contact_details"]), signal: controller.signal })))
      .rejects.toBeInstanceOf(RuntimeCancelledError);
    expect(store.size).toBe(0);
  });

  it("does not audit itself: one execution produces exactly one record and the registry is unchanged", async () => {
    const store = new SpyAuditStore();
    const registry = registryWith({ save_contact_details: async () => ({ ok: true, summary: "saved" }) });
    const boundBefore = registry.boundNames();
    const { runtime } = makeRuntime({ llm: toolTurn([toolCall("c1", "save_contact_details", { phone: "+15550001234" })]), toolAudit: store, registry });
    await runtime.run(makeInput({ agent: grantedAgent(["save_contact_details"]) }));
    expect(store.inner.size).toBe(1);
    expect(store.calls).toEqual(["started:save_contact_details", "finished:succeeded"]);
    expect(registry.boundNames()).toEqual(boundBefore);
    expect(Object.keys(BUILTIN_TOOLS).some((n) => n.includes("audit"))).toBe(false);
  });
});
