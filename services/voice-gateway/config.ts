import { z } from "zod";
import { STT_PROVIDER_NAMES, TTS_PROVIDER_NAMES } from "@halo/providers/voice-vendors/factory";

/**
 * Voice gateway configuration. Fails closed: the process refuses to start
 * without a webhook-signing secret and a stream-token secret, so no build of
 * this service can accept unauthenticated telephony traffic.
 *
 * Speech vendors (Phase 4.5 Sprint 1): `fake` is the deterministic pair used
 * by tests and the mock demo; `sarvam` is the first real adapter. Selecting a
 * real vendor REQUIRES its credential here, so a deployment that would answer
 * a call it cannot transcribe or speak refuses to start instead.
 *
 * No vendor has been exercised against its live endpoint from this
 * repository (docs/KNOWN_LIMITATIONS.md): selecting `sarvam` is a
 * configuration decision, not a validated quality claim.
 */
export const gatewayConfigSchema = z
  .object({
    port: z.coerce.number().int().min(1).max(65535).default(8787),
    /** Public wss:// URL the telephony provider is told to connect to. */
    publicWsUrl: z.string().url(),
    streamTokenSecret: z.string().min(32),
    streamTokenTtlMs: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
    telephonyProvider: z.enum(["twilio", "fake"]),
    twilioAccountSid: z.string().optional(),
    twilioAuthToken: z.string().optional(),
    fakeWebhookSecret: z.string().optional(),
    sttProvider: z.enum(STT_PROVIDER_NAMES).default("fake"),
    sttApiKey: z.string().optional(),
    sttModel: z.string().optional(),
    /** Vendor output mode; see the adapter for what each one returns. */
    sttMode: z.enum(["transcribe", "verbatim", "translit", "codemix"]).optional(),
    sttBaseUrl: z.string().url().optional(),
    ttsProvider: z.enum(TTS_PROVIDER_NAMES).default("fake"),
    ttsApiKey: z.string().optional(),
    ttsModel: z.string().optional(),
    /**
     * Voice used only when an agent version configures no `voice.ttsVoice`.
     * Required with a real vendor: the platform does not pick a voice for a
     * tenant's callers by default.
     */
    ttsDefaultVoice: z.string().optional(),
    ttsBaseUrl: z.string().url().optional(),
    maxConcurrentSessions: z.coerce.number().int().min(1).max(500).default(50),
    /**
     * Where the media loop runs. `in_process` is the Phase 3 engine (STT,
     * TTS and VAD in this process, fed by the `/media` socket). `pipecat`
     * hands the media loop to a Pipecat worker, which streams the call from
     * the provider and talks to HALO over `/pipecat/control`
     * (docs/PIPECAT_INTEGRATION.md).
     */
    mediaEngine: z.enum(["in_process", "pipecat"]).default("in_process"),
    /** wss:// endpoint on the Pipecat worker the provider is told to stream to. */
    pipecatMediaWsUrl: z.string().url().optional(),
  })
  .refine((c) => c.mediaEngine !== "pipecat" || Boolean(c.pipecatMediaWsUrl), {
    message: "VOICE_PIPECAT_MEDIA_WS_URL is required when VOICE_MEDIA_ENGINE=pipecat",
  })
  .refine((c) => c.telephonyProvider !== "twilio" || (c.twilioAccountSid && c.twilioAuthToken), {
    message: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required for the twilio provider",
  })
  .refine((c) => c.telephonyProvider !== "fake" || (c.fakeWebhookSecret ?? "").length >= 16, {
    message: "VOICE_FAKE_WEBHOOK_SECRET (≥16 chars) is required for the fake provider",
  })
  .refine((c) => c.sttProvider === "fake" || Boolean(c.sttApiKey), {
    message: "VOICE_STT_API_KEY is required unless VOICE_STT_PROVIDER=fake",
  })
  .refine((c) => c.ttsProvider === "fake" || Boolean(c.ttsApiKey), {
    message: "VOICE_TTS_API_KEY is required unless VOICE_TTS_PROVIDER=fake",
  })
  .refine((c) => c.ttsProvider === "fake" || Boolean(c.ttsDefaultVoice), {
    message: "VOICE_TTS_DEFAULT_VOICE is required unless VOICE_TTS_PROVIDER=fake",
  });

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

export function loadGatewayConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  const parsed = gatewayConfigSchema.safeParse({
    port: env.VOICE_GATEWAY_PORT,
    publicWsUrl: env.VOICE_GATEWAY_PUBLIC_WS_URL,
    streamTokenSecret: env.VOICE_STREAM_TOKEN_SECRET,
    streamTokenTtlMs: env.VOICE_STREAM_TOKEN_TTL_MS,
    telephonyProvider: env.TELEPHONY_PROVIDER,
    twilioAccountSid: env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN,
    fakeWebhookSecret: env.VOICE_FAKE_WEBHOOK_SECRET,
    sttProvider: env.VOICE_STT_PROVIDER,
    sttApiKey: env.VOICE_STT_API_KEY,
    sttModel: env.VOICE_STT_MODEL,
    sttMode: env.VOICE_STT_MODE,
    sttBaseUrl: env.VOICE_STT_BASE_URL,
    ttsProvider: env.VOICE_TTS_PROVIDER,
    ttsApiKey: env.VOICE_TTS_API_KEY,
    ttsModel: env.VOICE_TTS_MODEL,
    ttsDefaultVoice: env.VOICE_TTS_DEFAULT_VOICE,
    ttsBaseUrl: env.VOICE_TTS_BASE_URL,
    maxConcurrentSessions: env.VOICE_MAX_CONCURRENT_SESSIONS,
    mediaEngine: env.VOICE_MEDIA_ENGINE,
    pipecatMediaWsUrl: env.VOICE_PIPECAT_MEDIA_WS_URL,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ");
    throw new Error(`voice gateway configuration is invalid: ${issues}`);
  }
  return parsed.data;
}
