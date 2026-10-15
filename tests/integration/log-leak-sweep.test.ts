import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppError } from "@halo/core/errors/app-error";
import type { BusinessEvent, WorkflowDefinition } from "@halo/core/domain/workflow";
import type { KnowledgeProvider } from "@halo/ports/knowledge-provider";
import { LogMessagingProvider } from "@halo/providers/messaging/log-messaging-provider";
import { ResendMessagingProvider } from "@halo/providers/messaging/resend-messaging-provider";
import { resetEnvCacheForTests } from "@halo/platform/env";
import { ProviderKnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import { BUILTIN_TOOLS, ToolRegistry, type AnyToolExecutor } from "@halo/runtime/tools/registry";
import { FallbackLLMRouter } from "@halo/providers/llm/fallback-router";
import { WorkflowEngine } from "@halo/workflows/engine";
import { InMemoryWorkflowStore } from "../mocks/in-memory-workflow-store";
import { makeAgent, makeInput, makeRuntime, reply, ScriptedLLM } from "../mocks/runtime-fakes";
import { buildGateway } from "../mocks/voice-gateway-harness";
import { ScriptedTurnHandler } from "../mocks/voice-harness";

/**
 * W7.2 / G3.5 — log-leak sweep. Representative chat, tool, knowledge, LLM
 * failover, voice, workflow and messaging paths run at the most verbose log
 * level with telemetry on, carrying distinctive synthetic personal data in
 * every field a caller controls: message text, names, phone numbers, emails,
 * tool arguments, provider error text and thrown exception messages. Every
 * line written to the console is captured, and none may contain any of it.
 *
 * This proves the paths exercised here, not every log site in the codebase:
 * a new static message that interpolates personal data would need its own
 * path added to this sweep.
 */

const NAME = "Zephyrine Quillfeather";
const EMAIL = "zephyrine.q@example.test";
const PHONE = "+919849011223";
const PHONE_FORMS = [PHONE, "9849011223", "98490 11223", "98490-11223"];
const TEXT = "MARKER-ROOFTOP-ORCHID";
const TELUGU = "జెఫిరైన్ ఇంటి పైకప్పు";
const UTTERANCE = `${TEXT} naa peru ${NAME}, call me on ${PHONE} or ${EMAIL} — ${TELUGU}`;
const MARKERS = [NAME, "Quillfeather", EMAIL, "zephyrine.q", ...PHONE_FORMS, TEXT, TELUGU];

const lines: string[] = [];
const methods = ["log", "info", "warn", "error", "debug"] as const;

beforeAll(() => {
  vi.stubEnv("LOG_LEVEL", "debug");
  vi.stubEnv("HALO_TELEMETRY", "stdout");
  for (const method of methods) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterEach(() => vi.useRealTimers());

function leaks(): string[] {
  return lines.filter((line) => MARKERS.some((marker) => line.toLowerCase().includes(marker.toLowerCase())));
}

describe("log-leak sweep (W7.2)", () => {
  it("chat turn: tool arguments, failing tools, knowledge errors and provider failover log no personal data", async () => {
    const before = lines.length;
    const failingKnowledge: KnowledgeProvider = {
      name: "fake-knowledge",
      async search() { throw new Error(`index lookup failed for ${UTTERANCE}`); },
      async indexRevision() { return "ready" as const; },
    };
    const throwingHandoff: AnyToolExecutor = async () => { throw new Error(`handoff crashed for ${NAME} ${PHONE}`); };
    const agent = makeAgent();
    agent.config.tools.grantedToolIds = ["request_human_handoff"];
    const llm = new ScriptedLLM([
      reply("", { toolCalls: [{ id: "t1", name: "request_human_handoff", arguments: { reason: UTTERANCE } }], finishReason: "tool_calls" }),
      reply(`Thanks ${NAME}, we will call ${PHONE}.`),
    ]);
    const { runtime } = makeRuntime({
      llm,
      knowledge: new ProviderKnowledgeResolver(failingKnowledge),
      registry: new ToolRegistry(BUILTIN_TOOLS, { request_human_handoff: throwingHandoff }),
    });
    const output = await runtime.run(makeInput({ agent, userMessage: UTTERANCE }));
    expect(output.degraded.knowledge).toBe(true);
    // The executor really ran (and threw) with the personal data in its arguments.
    expect(output.toolResults.map((r) => [r.name, r.status])).toEqual([["request_human_handoff", "failed"]]);

    const router = new FallbackLLMRouter([
      { model: "m1", provider: { name: "groq", isHealthy: async () => true,
        complete: async () => { throw AppError.provider(`upstream echoed ${UTTERANCE}`, { category: "provider_5xx", body: UTTERANCE }); } } },
      { model: "m2", provider: { name: "openrouter", isHealthy: async () => true,
        complete: async () => { throw AppError.provider(`second echoed ${EMAIL}`, { category: "timeout" }); } } },
    ]);
    const failing = makeRuntime({ llm: router });
    const fallback = await failing.runtime.run(makeInput({ userMessage: UTTERANCE }));
    expect(fallback.degraded.provider).toBe(true);

    expect(lines.length).toBeGreaterThan(before);
    expect(lines.slice(before).some((l) => l.includes("knowledge resolution failed"))).toBe(true);
    expect(leaks()).toEqual([]);
  });

  it("voice call: caller number, spoken text and a crashing turn handler log no personal data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T10:00:00Z"));
    const before = lines.length;
    const handler = new ScriptedTurnHandler()
      .then({ reply: `Namaskaram ${NAME}, mee number ${PHONE} note chesanu.` })
      .then(() => { throw new Error(`turn failed while handling ${UTTERANCE}`); });
    const g = buildGateway({ handler });
    const { result } = await g.connect({ providerCallId: "CA-LEAK", from: PHONE });
    if (!result.ok) throw new Error("expected a session");
    await g.settle(2_000);
    await g.caller.say(result.sessionId, UTTERANCE);
    await g.settle(3_000);
    await g.caller.say(result.sessionId, `${TEXT} again ${EMAIL}`);
    await g.settle(3_000);
    g.gateway.mediaDisconnected(result.sessionId);
    await g.settle(10_000);

    const call = g.callStore.calls.get(result.call.id)!;
    expect(call.fromNumber).toBe(PHONE); // the number was really in the call
    expect(g.callStore.transcripts.get(call.id)!.some((t) => t.text.includes(TEXT))).toBe(true);
    expect(lines.length).toBeGreaterThan(before);
    expect(leaks()).toEqual([]);
  });

  it("workflow: event payload and a failing action's exception text log no personal data", async () => {
    const before = lines.length;
    const store = new InMemoryWorkflowStore();
    const workflow: WorkflowDefinition = {
      id: "wf-leak", businessId: "biz-1", name: "Follow up", description: "", trigger: "appointment.created",
      enabled: true, version: 1, conditions: [],
      steps: [{ id: "email", action: "send_email", params: { to: "{{event.payload.visitorEmail}}", body: "Hi {{event.payload.visitorName}}" } }],
    };
    store.addWorkflow(workflow);
    const engine = new WorkflowEngine(store, {
      send_email: async (params) => { throw new Error(`smtp rejected ${String(params.to)} body ${String(params.body)}`); },
    });
    const event: BusinessEvent = {
      id: "evt-leak", businessId: "biz-1", type: "appointment.created", correlationId: "conv-1",
      occurredAt: "2026-07-14T10:00:00.000Z",
      payload: { visitorName: NAME, visitorEmail: EMAIL, visitorPhone: PHONE, notes: UTTERANCE },
    };
    await engine.dispatch(event);
    expect(lines.length).toBeGreaterThan(before);
    expect(leaks()).toEqual([]);
  });

  it("log-mode messaging: recipient and body are never written", async () => {
    const before = lines.length;
    await new LogMessagingProvider().send({ channel: "sms", to: PHONE, subject: `For ${NAME}`, body: UTTERANCE, html: `<p>${EMAIL}</p>` });
    await new LogMessagingProvider().send({ channel: "email", to: EMAIL, subject: TEXT, body: UTTERANCE });
    expect(lines.slice(before).some((l) => l.includes("outbound message (log-only delivery)"))).toBe(true);
    expect(leaks()).toEqual([]);
  });

  it("Resend delivery (fetch stubbed): a successful send logs neither recipient nor subject", async () => {
    const before = lines.length;
    resetEnvCacheForTests();
    vi.stubEnv("RESEND_API_KEY", "re_synthetic_sweep_key");
    vi.stubEnv("RESEND_FROM_EMAIL", "noreply@example.test");
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await new ResendMessagingProvider().send({ channel: "email", to: EMAIL, subject: `Visit for ${NAME}`, body: UTTERANCE });
    } finally {
      vi.unstubAllGlobals();
      resetEnvCacheForTests();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lines.slice(before).some((l) => l.includes("outbound email sent via resend"))).toBe(true);
    expect(leaks()).toEqual([]);
  });

  it("the sweep is not vacuous: it catches a leaking log line", () => {
    const before = lines.length;
    console.warn(JSON.stringify({ msg: `debug ${EMAIL}` }));
    expect(leaks().length).toBe(1);
    lines.splice(before);
    expect(leaks()).toEqual([]);
  });
});
