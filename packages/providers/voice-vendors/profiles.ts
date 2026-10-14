import { z } from "zod";
import type { AudioFormat } from "@halo/ports/streaming-stt-provider";
import { createSttProvider, createTtsProvider, STT_PROVIDER_NAMES, TTS_PROVIDER_NAMES } from "./factory";
const common = { apiKey: z.string().optional(), baseUrl: z.url().optional(), model: z.string().max(100).optional(),
  modelDir: z.string().max(1000).optional(), threads: z.int().min(1).max(64).optional() };
const stt = z.object({ ...common, provider: z.enum(STT_PROVIDER_NAMES), mode: z.enum(["transcribe", "verbatim", "translit", "codemix"]).optional() }).strict();
const tts = z.object({ ...common, provider: z.enum(TTS_PROVIDER_NAMES), defaultSpeaker: z.string().max(100).optional() }).strict();
const profile = z.object({ sampleRate: z.int().min(8000).max(48000), stt: stt.extend({ fallback: stt.optional() }), tts: tts.extend({ fallback: tts.optional() }) }).strict();
const profiles = z.record(z.string(), z.record(z.string(), profile));
/** Deployment-owned profiles, scoped by tenant and referenced by immutable
 * agent config. Credentials and endpoints never cross the control protocol. */
export class VoiceProfiles {
  private readonly profiles: z.infer<typeof profiles>;
  // Built once per profile, like the gateway's default providers, so a
  // fallback's memory of a vendor outage outlives the call that found it.
  private readonly built = new Map<string, { stt: ReturnType<typeof createSttProvider>; tts: ReturnType<typeof createTtsProvider> }>();
  constructor(json = "{}") { this.profiles = profiles.parse(JSON.parse(json)); }
  resolve(businessId: string, profileId: string, wire: AudioFormat) {
    const definition = this.profiles[businessId]?.[profileId];
    if (!definition) throw new Error("Voice profile not configured for this tenant");
    // No implicit resampling: the selected carrier/transport determines audio
    // format. New transports may negotiate another supported sample rate.
    if (definition.sampleRate !== wire.sampleRate) throw new Error("Voice profile sample rate does not match transport");
    const key = JSON.stringify([businessId, profileId]);
    const speech = this.built.get(key) ?? { stt: createSttProvider(definition.stt), tts: createTtsProvider(definition.tts) };
    const { stt, tts } = speech;
    for (const provider of [stt, tts]) {
      if (!provider.capabilities().formats.some(f => f.sampleRate === wire.sampleRate && f.channels === wire.channels &&
        (f.encoding === wire.encoding || (wire.encoding === "mulaw" && f.encoding === "pcm16le")))) throw new Error("Voice profile format unavailable");
    }
    this.built.set(key, speech);
    return { stt, tts };
  }
}
