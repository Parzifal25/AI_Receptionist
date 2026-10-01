import { VoiceProfiles } from "@halo/providers/voice-vendors/profiles";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { LeadLifecycleStore } from "@halo/crm/lead-lifecycle-store";
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
import { SalesCallAssembly } from "@/core/services/voice/sales-call";
import { salesConfigForVersion } from "@/core/services/voice/sales-config";
import { visitBookingForCall } from "@/core/services/voice/visit-booking";
import { SupabaseCrmStore } from "@halo/crm/supabase-crm-store";
import { CrmService } from "@halo/crm/crm-service";
import type { VoiceCallContext } from "@halo/voice/gateway";

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
  const profiles = new VoiceProfiles(env.VOICE_PROFILES_JSON);

  const telephony: TelephonyProvider =
    config.telephonyProvider === "twilio"
      ? new TwilioMediaStreamProvider({ accountSid: config.twilioAccountSid!, authToken: config.twilioAuthToken! })
      : new FakeTelephonyProvider(config.fakeWebhookSecret!);

  const callStore = new SupabaseCallStore();
  const conversations = new SupabasePhoneConversationStore();
  const stateStore = new SupabaseConversationStateStore();
  const knowledge = new ProviderKnowledgeResolver(getKnowledgeProvider());
  const llm = getLLMProvider();
  const crmStore = new SupabaseCrmStore();
  const crm = new CrmService(crmStore);
  const lifecycle = new LeadLifecycleStore();
  const assemblies = new Map<string, SalesCallAssembly>();
  const customerNumber = (ctx: VoiceCallContext) => ctx.call.direction === "outbound" ? ctx.call.toNumber : ctx.call.fromNumber;

  // With the Pipecat engine the media loop runs in a worker and the speech
  // providers below are never opened: STT, TTS and VAD all happen there.
  // They remain wired because the gateway's dependency list is
  // engine-independent.
  const pipecat = config.mediaEngine === "pipecat" ? new PipecatBridge() : null;

  const sttConfig = {
      provider: config.sttProvider,
      ...(config.sttFallbackBaseUrl ? { fallback: { provider: "self-hosted" as const, baseUrl: config.sttFallbackBaseUrl } } : {}),
      ...(config.sttApiKey ? { apiKey: config.sttApiKey } : {}),
      ...(config.sttModel ? { model: config.sttModel } : {}),
      ...(config.sttMode ? { mode: config.sttMode } : {}),
      ...(config.sttBaseUrl ? { baseUrl: config.sttBaseUrl } : {}),
    };
  const stt = createSttProvider(sttConfig);
  const webStt = createSttProvider({ ...sttConfig, endpointing: "manual" });

  const gateway = new VoiceGateway({
    callStore,
    telephony,
    stt,
    tts: createTtsProvider({
      provider: config.ttsProvider,
      ...(config.ttsFallbackBaseUrl ? { fallback: { provider: "self-hosted" as const, baseUrl: config.ttsFallbackBaseUrl } } : {}),
      ...(config.ttsApiKey ? { apiKey: config.ttsApiKey } : {}),
      ...(config.ttsModel ? { model: config.ttsModel } : {}),
      ...(config.ttsDefaultVoice ? { defaultSpeaker: config.ttsDefaultVoice } : {}),
      ...(config.ttsBaseUrl ? { baseUrl: config.ttsBaseUrl } : {}),
    }),
    speechForCall: ctx => {
      const id = ctx.route.version.config.voice.profileId;
      if (!id) throw new Error("Internal profile resolver called without a profile");
      return profiles.resolve(ctx.call.businessId, id, telephony.createMediaCodec().format);
    },
    limits: { maxConcurrentSessions: config.maxConcurrentSessions },
    ...(pipecat ? { createMediaSession: pipecat.createMediaSession } : {}),
    createTurnHandler: (ctx) => {
      const events = { emit: (event: import("@halo/runtime/contracts").RuntimeEvent) => gateway.recordRuntimeEvent(ctx.call.id, event) };
      const sales = salesConfigForVersion(ctx.route.version.config);
      if (sales) {
        const assembly = new SalesCallAssembly({ config: sales, llm, knowledge, conversations, stateStore, events,
          booking: visitBookingForCall,
          loadKnownFields: async (call): Promise<Record<string, string>> => {
            const known = await crmStore.findByPhone(call.call.businessId, customerNumber(call));
            // Caller ID alone is not proof of identity: preload only contact
            // fields, never private account data or commercial history.
            return known ? { name: known.name, phone: known.phone } : {};
          },
          suppress: async (call) => callStore.suppress({ businessId: call.call.businessId,
            e164: customerNumber(call), reason: "do_not_call", callId: call.call.id }),
        });
        assemblies.set(ctx.call.id, assembly);
        return assembly.createTurnHandler(ctx);
      }
      return new PhoneTurnHandler({
        events,
        agent: resolvedContextForCall({ business: ctx.route.business, agentId: ctx.route.agentId, version: ctx.route.version }),
        conversationId: ctx.conversationId,
        store: conversations,
        llm,
        knowledge,
        stateStore,
        liveHandoffAvailable: ctx.handoffNumber !== null,
      });
    },
    computeOutcome: (ctx, summary) => {
      const assembly = assemblies.get(ctx.call.id);
      assemblies.delete(ctx.call.id);
      return assembly ? assembly.computeOutcome(ctx, summary) : {
        disposition: summary.transferred ? "escalated_to_human" : "no_outcome",
        dispositionReason: "no sales policy configured", qualification: {}, appointmentId: null,
        escalated: summary.transferRequested, doNotCall: false,
      };
    },
    onOutcome: async (ctx, outcome) => {
      const fields = outcome.qualification.fields as Record<string, string> | undefined;
      const number = customerNumber(ctx);
      // Apply suppression to existing identities even when the caller supplied
      // no contact fields. Do not merge identities based on unverified speech.
      let customer = await crmStore.findByPhone(ctx.call.businessId, number);
      if (!outcome.doNotCall && fields?.name && fields.phone === number) {
        customer = (await crm.upsertCustomer(ctx.call.businessId, { name: fields.name, phone: number,
          stage: outcome.appointmentId ? "booked" : "engaged", source: "phone" })).customer;
      }
      if (customer) await lifecycle.applyCallOutcome(ctx.call.businessId, customer.id, ctx.call.id);
    },
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
    webStt,
    config,
    gateway,
    telephony,
    ...(pipecat ? { pipecat } : {}),
    bindOutbound: async ({ attemptKey, providerCallId, from, to }) => {
      const match = /^([a-f0-9-]{36}):([1-9]\d?)$/.exec(attemptKey);
      if (!match) return false;
      const { data, error } = await getAdminClient().rpc("bind_campaign_callback", { p_contact_id: match[1], p_attempt: Number(match[2]),
        p_provider: telephony.name, p_provider_call_id: providerCallId, p_from: from, p_to: to });
      if (error) throw new Error("Campaign callback binding failed");
      return data === true;
    },
    canAnswerOutbound: async ({ providerCallId, from, to }) => {
      const call = await callStore.getCallByProviderId(telephony.name, providerCallId);
      if (!call || call.direction !== "outbound" || call.fromNumber !== from || call.toNumber !== to ||
          await callStore.isSuppressed(call.businessId, to)) return false;
      const { data: contact, error } = await getAdminClient().from("campaign_contacts").select("id")
        .eq("business_id", call.businessId).eq("provider_call_id", providerCallId).eq("state", "accepted").maybeSingle();
      if (error || !contact) return false;
      const eligible = await getAdminClient().rpc("campaign_contact_eligible", { p_business_id: call.businessId, p_contact_id: contact.id });
      if (eligible.error || eligible.data !== true) return false;
      const route = await callStore.resolveCallRoute(call);
      if (route?.version.config.voice.profileId) profiles.resolve(route.business.id, route.version.config.voice.profileId, telephony.createMediaCodec().format);
      return Boolean(route && buildSessionConfig(route.version.config).ok);
    },
    canAnswer: async ({ to }) => {
      try {
        const route = await callStore.resolveInboundRoute(telephony.name, to);
        if (!route) return false;
        const profileId = route.version.config.voice.profileId;
        if (profileId) profiles.resolve(route.business.id, profileId, telephony.createMediaCodec().format);
        const built = buildSessionConfig(route.version.config);
        salesConfigForVersion(route.version.config); // malformed sales policy refuses the call
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
