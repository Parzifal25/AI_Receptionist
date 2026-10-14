import { observe } from "@halo/platform/telemetry";
import { TtsError, type StreamingTtsProvider, type TtsRequest } from "@halo/ports/streaming-tts-provider";
import { ProviderCircuit, type CircuitOptions, type CircuitState } from "./provider-circuit";

export interface FallbackCircuitOptions extends Omit<CircuitOptions, "onChange"> {
  onChange?: (change: { provider: string; state: CircuitState; cooldownMs: number }) => void;
}

/** A failed utterance may switch providers only BEFORE any audio is released.
 * Replaying after partial speech would repeat promises/actions to the caller.
 *
 * Only a RECOVERABLE failure moves on: a `TtsError` the vendor marked
 * `retryable`, or a provider that returned no audio. A non-retryable error
 * (a rejected credential, an unknown voice) and anything that is not a
 * `TtsError` (a defect) are thrown as they are.
 *
 * Every provider but the last has a circuit (provider-circuit.ts): once it
 * has failed recoverably `failureThreshold` times in a row it is skipped, so
 * an outage costs the caller its timeout a bounded number of times instead of
 * before every line, and a later probe moves speech back to it. */
export class FallbackTtsProvider implements StreamingTtsProvider {
  readonly name = "fallback-tts";
  private readonly circuits: ProviderCircuit[];
  constructor(private readonly providers: readonly { provider: StreamingTtsProvider; voiceId?: string }[], circuit: FallbackCircuitOptions = {}) {
    if (!providers.length) throw new Error("TTS fallback requires a provider");
    this.circuits = providers.map(entry => new ProviderCircuit({ ...circuit, onChange: change => circuit.onChange?.({ provider: entry.provider.name, ...change }) }));
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
    const compatible = this.providers.map((entry, index) => ({ ...entry, circuit: this.circuits[index] })).filter(entry => entry.provider.capabilities().formats
      .some(f => f.encoding === request.format.encoding && f.sampleRate === request.format.sampleRate && f.channels === request.format.channels));
    for (const [position, entry] of compatible.entries()) {
      // The last provider that can serve this request is always tried.
      const circuit = position + 1 < compatible.length ? entry.circuit : undefined;
      if (circuit && !circuit.acquire()) continue;
      if (position > 0) observe("voice.fallback", { component: "voice", operation: "tts", provider: entry.provider.name });
      let released = false, verdict = false;
      const settle = (ok: boolean) => { if (!verdict) { verdict = true; if (ok) circuit?.success(); else circuit?.failure(); } };
      try {
        for await (const audio of entry.provider.synthesize({ ...request, ...(entry.voiceId ? { voiceId: entry.voiceId } : {}) }, signal)) {
          if (signal.aborted) return;
          if (!audio.byteLength) continue;
          released = true; settle(true);
          yield audio;
        }
        if (signal.aborted || released) return;
        settle(false);
        error = new TtsError("provider", "Speech provider returned no audio", true);
      } catch (cause) {
        if (signal.aborted) return;
        // Only an outage counts against the provider; a rejected credential or a defect is not one.
        if (cause instanceof TtsError && cause.retryable && !released) settle(false);
        if (released || !(cause instanceof TtsError) || !cause.retryable) throw cause;
        error = cause;
      } finally {
        // Aborted, abandoned by the consumer or failed without a verdict: free a probe slot.
        if (!verdict) circuit?.release();
      }
    }
    throw error;
  }
}
