import { z } from "zod";

/**
 * Voice gateway configuration. Fails closed: the process refuses to start
 * without a webhook-signing secret and a stream-token secret, so no build of
 * this service can accept unauthenticated telephony traffic.
 *
 * Real STT/TTS vendors are NOT selectable yet: the Phase 4 vendor evaluation
 * (plan §P4) has not run and no credentials exist, so only the deterministic
 * fakes are wired. Adding a vendor is a new adapter plus one enum value.
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
    sttProvider: z.enum(["fake"]).default("fake"),
    ttsProvider: z.enum(["fake"]).default("fake"),
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
    ttsProvider: env.VOICE_TTS_PROVIDER,
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
