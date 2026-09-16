import { vi } from "vitest";
import { defaultAgentConfig, type AgentVersion } from "@halo/core/domain/agents";
import { FakeSttProvider } from "@halo/providers/voice-fakes/fake-stt-provider";
import { FakeTtsProvider } from "@halo/providers/voice-fakes/fake-tts-provider";
import { FakeTelephonyProvider } from "@halo/providers/voice-fakes/fake-telephony-provider";
import type { InboundRoute } from "@halo/voice/call-store";
import { VoiceGateway, type OutcomeDraft, type VoiceCallContext, type VoiceGatewayDeps } from "@halo/voice/gateway";
import { InMemoryCallStore } from "@halo/voice/in-memory-call-store";
import { DEFAULT_VOICE_SESSION_CONFIG } from "@halo/voice/voice-session";
import type { VoiceSessionSummary } from "@halo/voice/voice-session";
import { BUSINESS_A, BUSINESS_B } from "./runtime-fakes";
import { ScriptedTurnHandler, SimulatedPlayout, TEST_PROMPTS, mulawFrame, FRAME_MS } from "./voice-harness";

export function makeVersion(businessId: string, agentId: string, id: string): AgentVersion {
  return {
    id,
    agentId,
    businessId,
    version: 3,
    config: defaultAgentConfig(),
    promptTemplate: "You are a voice agent.",
    promptVersion: "2026-09-16.1",
    model: {},
    publishedAt: "2026-09-01T00:00:00Z",
    createdBy: null,
    createdAt: "2026-09-01T00:00:00Z",
  };
}

export const TENANT_A_DID = "+914000000001";
export const TENANT_B_DID = "+914000000002";

export function buildGateway(opts: {
  handler?: ScriptedTurnHandler;
  handoffNumber?: string | null;
  limits?: VoiceGatewayDeps["limits"];
  computeOutcome?: (ctx: VoiceCallContext, summary: VoiceSessionSummary) => OutcomeDraft;
} = {}) {
  const callStore = new InMemoryCallStore();
  const telephony = new FakeTelephonyProvider("secret");
  const stt = new FakeSttProvider();
  const tts = new FakeTtsProvider({ msPerChar: 20, chunkMs: 100 });
  const handler = opts.handler ?? new ScriptedTurnHandler();

  const routeA: InboundRoute = {
    phoneNumberId: "pn-a",
    business: BUSINESS_A,
    agentId: "agent-a",
    agentStatus: "active",
    version: makeVersion(BUSINESS_A.id, "agent-a", "av-a-3"),
    handoffNumber: opts.handoffNumber === undefined ? null : opts.handoffNumber,
  };
  const routeB: InboundRoute = {
    phoneNumberId: "pn-b",
    business: BUSINESS_B,
    agentId: "agent-b",
    agentStatus: "active",
    version: makeVersion(BUSINESS_B.id, "agent-b", "av-b-3"),
    handoffNumber: null,
  };
  callStore.addRoute("fake", TENANT_A_DID, routeA);
  callStore.addRoute("fake", TENANT_B_DID, routeB);

  const outputs: SimulatedPlayout[] = [];
  const gateway = new VoiceGateway({
    callStore,
    stt,
    tts,
    telephony,
    createTurnHandler: () => handler,
    sessionConfig: () => ({ ...DEFAULT_VOICE_SESSION_CONFIG, language: "te-IN", prompts: TEST_PROMPTS, endpointer: { sampleRate: 8000, speechThreshold: 0.05, minSpeechMs: 100, endHangoverMs: 400 } }),
    ...(opts.computeOutcome ? { computeOutcome: opts.computeOutcome } : {}),
    limits: opts.limits,
  });

  async function connect(params: { providerCallId: string; to?: string; from?: string } ) {
    const output = new SimulatedPlayout();
    outputs.push(output);
    const result = await gateway.startSession({
      provider: "fake",
      providerCallId: params.providerCallId,
      from: params.from ?? "+919800000001",
      to: params.to ?? TENANT_A_DID,
      output,
    });
    if (result.ok) output.onMark = (name) => gateway.receiveEvent(result.sessionId, { type: "mark", name });
    return { result, output };
  }

  const SPEECH = mulawFrame(0.3);
  const SILENCE = mulawFrame(0);
  const caller = {
    async speak(sessionId: string, ms: number) {
      for (let t = 0; t < ms; t += FRAME_MS) {
        gateway.receiveAudio(sessionId, SPEECH);
        await vi.advanceTimersByTimeAsync(FRAME_MS);
      }
    },
    async silence(sessionId: string, ms: number) {
      for (let t = 0; t < ms; t += FRAME_MS) {
        gateway.receiveAudio(sessionId, SILENCE);
        await vi.advanceTimersByTimeAsync(FRAME_MS);
      }
    },
    async say(sessionId: string, text: string) {
      await this.speak(sessionId, 400);
      stt.current.final(text);
      await this.silence(sessionId, 600);
    },
  };

  return { gateway, callStore, telephony, stt, tts, handler, connect, caller, outputs, routeA, routeB, settle: (ms: number) => vi.advanceTimersByTimeAsync(ms) };
}
