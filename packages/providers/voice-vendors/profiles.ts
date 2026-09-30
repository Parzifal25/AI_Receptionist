import { z } from "zod";
import type { AudioFormat } from "@halo/ports/streaming-stt-provider";
import { createSttProvider, createTtsProvider, STT_PROVIDER_NAMES, TTS_PROVIDER_NAMES } from "./factory";
const common = { apiKey: z.string().optional(), baseUrl: z.url().optional(), model: z.string().max(100).optional() };
const stt = z.object({ ...common, provider: z.enum(STT_PROVIDER_NAMES), mode: z.enum(["transcribe", "verbatim", "translit", "codemix"]).optional() }).strict();
const tts = z.object({ ...common, provider: z.enum(TTS_PROVIDER_NAMES), defaultSpeaker: z.string().max(100).optional() }).strict();
const profile = z.object({ sampleRate: z.int().min(8000).max(48000), stt: stt.extend({ fallback: stt.optional() }), tts: tts.extend({ fallback: tts.optional() }) }).strict();
const profiles = z.record(z.string(), z.record(z.string(), profile));
/** Deployment-owned profiles, scoped by tenant and referenced by immutable
 * agent config. Credentials and endpoints never cross the control protocol. */
export class VoiceProfiles {
  private readonly profiles: z.infer<typeof profiles>;
  constructor(json = "{}") { this.profiles = profiles.parse(JSON.parse(json)); }
  resolve(businessId: string, profileId: string, wire: AudioFormat) {
    const definition = this.profiles[businessId]?.[profileId];
    if (!definition) throw new Error("Voice profile not configured for this tenant");
    // No implicit resampling: the selected carrier/transport determines audio
    // format. New transports may negotiate another supported sample rate.
    if (definition.sampleRate !== wire.sampleRate) throw new Error("Voice profile sample rate does not match transport");
    const stt = createSttProvider(definition.stt), tts = createTtsProvider(definition.tts);
    for (const provider of [stt, tts]) {
      if (!provider.capabilities().formats.some(f => f.sampleRate === wire.sampleRate && f.channels === wire.channels &&
        (f.encoding === wire.encoding || (wire.encoding === "mulaw" && f.encoding === "pcm16le")))) throw new Error("Voice profile format unavailable");
    }
    return { stt, tts };
  }
}
