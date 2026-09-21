import { describe, expect, it } from "vitest";
import { loadGatewayConfig } from "../../services/voice-gateway/config";
import { PIPECAT_PROTOCOL_VERSION, encodeCommand, parsePipecatEvent } from "@halo/voice/pipecat/protocol";
import { BUILTIN_TOOLS, ToolRegistry } from "@halo/runtime/tools/registry";
import { concessionExecutor } from "@halo/negotiation/tool";
import { emptyNegotiationSnapshot } from "@halo/negotiation/authorization";
import { requireArunodhaya } from "@/content/tenants/arunodhaya";
import type { ToolExecutionContext } from "@halo/runtime/tools/registry";

/**
 * Phase 4 §16 — the security properties of the new surface, as tests rather
 * than assertions in a document. The transport-level proofs (token binding,
 * cross-tenant refusal, protocol version, malformed frames) live in
 * tests/integration/pipecat-gateway.test.ts; this covers the rest.
 */

const BASE_ENV = {
  VOICE_GATEWAY_PUBLIC_WS_URL: "wss://gateway.test/media",
  VOICE_STREAM_TOKEN_SECRET: "stream-token-secret-at-least-32-chars",
  TELEPHONY_PROVIDER: "fake",
  VOICE_FAKE_WEBHOOK_SECRET: "fake-webhook-secret-value",
};

describe("phase 4 security", () => {
  it("refuses to run the Pipecat engine without somewhere to send the media", () => {
    expect(() => loadGatewayConfig({ ...BASE_ENV, VOICE_MEDIA_ENGINE: "pipecat" })).toThrow(
      /VOICE_PIPECAT_MEDIA_WS_URL is required/,
    );
  });

  it("accepts only a real URL for the worker, so no arbitrary string becomes a stream target", () => {
    expect(() =>
      loadGatewayConfig({ ...BASE_ENV, VOICE_MEDIA_ENGINE: "pipecat", VOICE_PIPECAT_MEDIA_WS_URL: "not-a-url" }),
    ).toThrow();
    const ok = loadGatewayConfig({
      ...BASE_ENV,
      VOICE_MEDIA_ENGINE: "pipecat",
      VOICE_PIPECAT_MEDIA_WS_URL: "wss://worker.internal/ws",
    });
    expect(ok.pipecatMediaWsUrl).toBe("wss://worker.internal/ws");
  });

  it("admits only vetted providers — a vendor cannot be selected by configuration alone", () => {
    expect(() => loadGatewayConfig({ ...BASE_ENV, TELEPHONY_PROVIDER: "someone-else" })).toThrow();
    expect(() => loadGatewayConfig({ ...BASE_ENV, VOICE_STT_PROVIDER: "whisper-somewhere" })).toThrow();
    expect(() => loadGatewayConfig({ ...BASE_ENV, VOICE_TTS_PROVIDER: "a-vendor" })).toThrow();
  });

  it("still fails closed without a webhook secret or a long-enough stream secret", () => {
    const { VOICE_FAKE_WEBHOOK_SECRET: _s, ...noSecret } = BASE_ENV;
    expect(() => loadGatewayConfig(noSecret)).toThrow();
    expect(() => loadGatewayConfig({ ...BASE_ENV, VOICE_STREAM_TOKEN_SECRET: "short" })).toThrow();
  });

  it("never lets a control frame carry tenant, agent or session identity upward", () => {
    // A worker that tries to assert who it is for gets those fields dropped:
    // identity is not part of any inbound frame's schema.
    const parsed = parsePipecatEvent(
      JSON.stringify({
        type: "transcript",
        final: true,
        text: "hello",
        tenantId: "other-tenant",
        agentId: "other-agent",
        businessId: "other-business",
        conversationId: "other-conversation",
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(Object.keys(parsed.event).sort()).toEqual(["confidence", "final", "language", "text", "type"]);
  });

  it("sends the worker no secret of any kind", () => {
    const ready = encodeCommand({
      type: "ready",
      protocol: PIPECAT_PROTOCOL_VERSION,
      session: {
        tenantId: "biz-1",
        agentId: "agent-1",
        agentVersionId: "av-1",
        agentVersion: 1,
        callId: "call-1",
        sessionId: "call-1",
        conversationId: "conv-1",
        correlationId: "corr-1",
      },
      voice: {
        language: "te-IN",
        alternativeLanguages: ["en-IN"],
        phraseHints: ["solar"],
        vad: { minSpeechMs: 120, endHangoverMs: 900 },
        bargeIn: { enabled: true, minSpeechMs: 250 },
        maxCallDurationMs: 600_000,
      },
    });
    expect(ready).not.toMatch(/token|secret|key|password|authorization/i);
  });

  it("offers the model only tools that are actually bound, and rejects anything else", () => {
    const registry = new ToolRegistry(BUILTIN_TOOLS, { request_human_handoff: async () => ({ ok: true, summary: "" }) });
    expect(registry.boundNames()).toEqual(["request_human_handoff"]);
    // Defined but unbound: never offered, and there is nothing to execute.
    expect(registry.executor("offer_concession")).toBeNull();
    expect(registry.has("run_sql")).toBe(false);
    expect(() => new ToolRegistry(BUILTIN_TOOLS, { run_sql: async () => ({ ok: true, summary: "" }) })).toThrow(
      /unknown tool/,
    );
  });

  it("re-checks a concession against the policy at execution time, not only in the prompt", async () => {
    const { negotiation } = requireArunodhaya();
    const executor = concessionExecutor({
      policy: negotiation,
      snapshot: () => emptyNegotiationSnapshot(),
      recordOffer: () => {},
    });
    for (const id of ["standard_discount", "manager_approved_discount", "fifty_percent", ""]) {
      const outcome = await executor({ concessionId: id }, {} as ToolExecutionContext);
      expect(outcome.ok, `${id} must not be authorized`).toBe(false);
      expect(outcome.claimsPermitted).toEqual([]);
    }
  });

  it("keeps every commercial figure out of the model's reach for this tenant", () => {
    const { negotiation, config } = requireArunodhaya();
    expect(negotiation.priceDisclosure).toBe("none");
    // The prompt template is the only free-form text the model is given, and
    // it carries behaviour, never a figure it could repeat.
    expect(config.instructions.promptTemplate).not.toMatch(/\d+\s?%|₹|\bRs\.?\s?\d/);
  });
});
