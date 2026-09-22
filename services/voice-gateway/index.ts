import { logger } from "@halo/platform/logger";
import { getKnowledgeProvider } from "@halo/providers/knowledge/factory";
import { getLLMProvider } from "@halo/providers/llm/factory";
import { FakeTelephonyProvider } from "@halo/providers/voice-fakes/fake-telephony-provider";
import { createSttProvider, createTtsProvider } from "@halo/providers/voice-vendors/factory";
import { TwilioMediaStreamProvider } from "@halo/providers/telephony/twilio-media-stream-provider";
import type { TelephonyProvider } from "@halo/ports/telephony-provider";
import { ProviderKnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import { SupabaseConversationStateStore } from "@halo/runtime/stores/supabase-conversation-state-store";
import { VoiceGateway } from "@halo/voice/gateway";
import { PipecatBridge } from "@halo/voice/pipecat/bridge";
import { PhoneTurnHandler, resolvedContextForCall } from "@halo/voice/phone-channel-adapter";
import { buildSessionConfig } from "@halo/voice/session-config";
import { SupabaseCallStore, SupabasePhoneConversationStore } from "@halo/voice/stores/supabase-call-store";
import { loadGatewayConfig } from "./config";
import { createGatewayServer } from "./server";

/**
 * HALO voice gateway — production wiring.
 *
 * STT and TTS are selected by configuration (`VOICE_STT_PROVIDER` /
 * `VOICE_TTS_PROVIDER`) and built by the speech factories. The default is
 * still the deterministic FAKE pair, so an unconfigured deployment behaves
 * exactly as it did before Phase 4.5; setting a real vendor requires its
 * credential or the process refuses to start.
 *
 * Selecting a real vendor is not a quality claim. Telugu WER, TTS MOS and
 * real end-to-end latency over an Indian phone line remain UNMEASURED —
 * see docs/KNOWN_LIMITATIONS.md before reporting any of them.
 */

const log = logger.child({ service: "voice-gateway" });

export function buildGatewayFromEnv(env: Record<string, string | undefined> = process.env) {
  const config = loadGatewayConfig(env);

  const telephony: TelephonyProvider =
    config.telephonyProvider === "twilio"
      ? new TwilioMediaStreamProvider({ accountSid: config.twilioAccountSid!, authToken: config.twilioAuthToken! })
      : new FakeTelephonyProvider(config.fakeWebhookSecret!);

  const callStore = new SupabaseCallStore();
  const conversations = new SupabasePhoneConversationStore();
  const stateStore = new SupabaseConversationStateStore();
  const knowledge = new ProviderKnowledgeResolver(getKnowledgeProvider());
  const llm = getLLMProvider();

  // With the Pipecat engine the media loop runs in a worker and the speech
  // providers below are never opened: STT, TTS and VAD all happen there.
  // They remain wired because the gateway's dependency list is
  // engine-independent.
  const pipecat = config.mediaEngine === "pipecat" ? new PipecatBridge() : null;

  const gateway = new VoiceGateway({
    callStore,
    telephony,
    stt: createSttProvider({
      provider: config.sttProvider,
      ...(config.sttApiKey ? { apiKey: config.sttApiKey } : {}),
      ...(config.sttModel ? { model: config.sttModel } : {}),
      ...(config.sttMode ? { mode: config.sttMode } : {}),
      ...(config.sttBaseUrl ? { baseUrl: config.sttBaseUrl } : {}),
    }),
    tts: createTtsProvider({
      provider: config.ttsProvider,
      ...(config.ttsApiKey ? { apiKey: config.ttsApiKey } : {}),
      ...(config.ttsModel ? { model: config.ttsModel } : {}),
      ...(config.ttsDefaultVoice ? { defaultSpeaker: config.ttsDefaultVoice } : {}),
      ...(config.ttsBaseUrl ? { baseUrl: config.ttsBaseUrl } : {}),
    }),
    limits: { maxConcurrentSessions: config.maxConcurrentSessions },
    ...(pipecat ? { createMediaSession: pipecat.createMediaSession } : {}),
    createTurnHandler: (ctx) =>
      new PhoneTurnHandler({
        agent: resolvedContextForCall({ business: ctx.route.business, agentId: ctx.route.agentId, version: ctx.route.version }),
        conversationId: ctx.conversationId,
        store: conversations,
        llm,
        knowledge,
        stateStore,
        liveHandoffAvailable: ctx.handoffNumber !== null,
      }),
    sessionConfig: (ctx) => {
      const built = buildSessionConfig(ctx.route.version.config);
      if (!built.ok) {
        // Unreachable in practice: canAnswer() declines these calls before a
        // media socket is offered. Kept as a loud guard, never a default line.
        throw new Error(`agent ${ctx.route.agentId} is missing voice prompts: ${built.missing.join(", ")}`);
      }
      return built.config;
    },
  });

  pipecat?.bindGateway(gateway);

  const server = createGatewayServer({
    config,
    gateway,
    telephony,
    ...(pipecat ? { pipecat } : {}),
    canAnswer: async ({ to }) => {
      try {
        const route = await callStore.resolveInboundRoute(telephony.name, to);
        if (!route) return false;
        const built = buildSessionConfig(route.version.config);
        if (!built.ok) {
          log.error("agent is not configured for voice; declining", { agentId: route.agentId, missing: built.missing });
          return false;
        }
        return true;
      } catch (error) {
        log.error("routing check failed; declining", { error });
        return false;
      }
    },
  });

  return { config, gateway, server, telephony, pipecat };
}

export async function main(): Promise<void> {
  const { config, server } = buildGatewayFromEnv();
  const port = await server.listen();
  log.info("voice gateway listening", {
    port,
    publicWsUrl: config.publicWsUrl,
    telephony: config.telephonyProvider,
    mediaEngine: config.mediaEngine,
    stt: config.sttProvider,
    tts: config.ttsProvider,
  });

  let closing = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      log.info("draining voice gateway", { signal });
      void server
        .close()
        .then(() => process.exit(0))
        .catch((error) => {
          log.error("shutdown failed", { error });
          process.exit(1);
        });
    });
  }
}
