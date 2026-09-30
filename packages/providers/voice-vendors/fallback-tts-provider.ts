import { TtsError, type StreamingTtsProvider, type TtsRequest } from "@halo/ports/streaming-tts-provider";

/** A failed utterance may switch providers only BEFORE any audio is released.
 * Replaying after partial speech would repeat promises/actions to the caller. */
export class FallbackTtsProvider implements StreamingTtsProvider {
  readonly name = "fallback-tts";
  constructor(private readonly providers: readonly { provider: StreamingTtsProvider; voiceId?: string }[]) {
    if (!providers.length) throw new Error("TTS fallback requires a provider");
  }
  capabilities() {
    const caps = this.providers.map(entry => entry.provider.capabilities());
    return { languages: [...new Set(this.providers.flatMap(p => p.provider.capabilities().languages))],
      formats: caps[0].formats.filter(f => caps.every(c => c.formats.some(other => other.encoding === f.encoding && other.sampleRate === f.sampleRate && other.channels === f.channels))),
      voices: [...new Set(this.providers.flatMap(p => p.provider.capabilities().voices))] };
  }
  async *synthesize(request: TtsRequest, signal: AbortSignal): AsyncIterable<Uint8Array> {
    if (signal.aborted || !request.text.trim()) return;
    let error: unknown = new TtsError("provider", "No compatible speech provider", false);
    for (const entry of this.providers) {
      const caps = entry.provider.capabilities();
      if (!caps.formats.some(f => f.encoding === request.format.encoding && f.sampleRate === request.format.sampleRate && f.channels === request.format.channels)) continue;
      let released = false;
      try {
        for await (const audio of entry.provider.synthesize({ ...request, ...(entry.voiceId ? { voiceId: entry.voiceId } : {}) }, signal)) {
          if (signal.aborted) return;
          if (!audio.byteLength) continue;
          released = true;
          yield audio;
        }
        if (signal.aborted || released) return;
        error = new TtsError("provider", "Speech provider returned no audio", true);
      } catch (cause) {
        if (signal.aborted) return;
        if (released) throw cause;
        error = cause;
      }
    }
    throw error;
  }
}
