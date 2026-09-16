import { logger } from "@halo/platform/logger";
import { getKnowledgeProvider } from "@halo/providers/knowledge/factory";
import { getLLMProvider } from "@halo/providers/llm/factory";
import { FakeSttProvider } from "@halo/providers/voice-fakes/fake-stt-provider";
import { FakeTelephonyProvider } from "@halo/providers/voice-fakes/fake-telephony-provider";
import { FakeTtsProvider } from "@halo/providers/voice-fakes/fake-tts-provider";
import { TwilioMediaStreamProvider } from "@halo/providers/telephony/twilio-media-stream-provider";
import type { TelephonyProvider } from "@halo/ports/telephony-provider";
import { ProviderKnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import { SupabaseConversationStateStore } from "@halo/runtime/stores/supabase-conversation-state-store";
import { VoiceGateway } from "@halo/voice/gateway";
import { PhoneTurnHandler, resolvedContextForCall } from "@halo/voice/phone-channel-adapter";
import { buildSessionConfig } from "@halo/voice/session-config";
import { SupabaseCallStore, SupabasePhoneConversationStore } from "@halo/voice/stores/supabase-call-store";
import { loadGatewayConfig } from "./config";
import { createGatewayServer } from "./server";

/**
 * HALO voice gateway — production wiring.
 *
 * STT and TTS are the deterministic FAKES: the Phase 4 vendor evaluation
 * (plan §P4 — Telugu WER, MOS, latency over an Indian phone line) has not run
 * and no vendor credentials exist in this repository. The process therefore
 * runs end to end, and everything above the ports is real, but it cannot
 * transcribe or speak real audio until a vendor adapter is added.
 * See docs/KNOWN_LIMITATIONS.md.
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

  const gateway = new VoiceGateway({
    callStore,
    telephony,
    stt: new FakeSttProvider(),
    tts: new FakeTtsProvider(),
    limits: { maxConcurrentSessions: config.maxConcurrentSessions },
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

  const server = createGatewayServer({
    config,
    gateway,
    telephony,
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

  return { config, gateway, server, telephony };
}

export async function main(): Promise<void> {
  const { config, server } = buildGatewayFromEnv();
  const port = await server.listen();
  log.info("voice gateway listening", {
    port,
    publicWsUrl: config.publicWsUrl,
    telephony: config.telephonyProvider,
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
