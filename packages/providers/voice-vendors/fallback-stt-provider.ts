import { observe } from "@halo/platform/telemetry";
import type { StreamingSttProvider, SttEvent, SttStream, SttStreamOptions } from "@halo/ports/streaming-stt-provider";
import type { FallbackCircuitOptions } from "./fallback-tts-provider";
import { ProviderCircuit } from "./provider-circuit";

/** Bounded startup fallback. Audio is replayed only before the first final.
 * Once a final may have caused a business action, failure is surfaced instead
 * of replaying audio into a different recognizer and duplicating the action.
 *
 * Only a RECOVERABLE failure moves to the next provider: an error the vendor
 * marked `retryable`, or a stream that closed without one. A non-retryable
 * error (a rejected credential, unsupported audio) and a provider that
 * throws from `open()` — which the port forbids for runtime problems, so it
 * is a defect — are surfaced, never papered over by another provider.
 *
 * Every provider but the last has a circuit (provider-circuit.ts), shared by
 * all streams of this instance: a provider that keeps failing recoverably is
 * skipped at `open()` instead of costing each new stream its connect
 * timeout, and is probed again after the cooldown. A stream counts as
 * healthy once the provider has sent any recognition event. */
export class FallbackSttProvider implements StreamingSttProvider {
  readonly name = "fallback-stt";
  private readonly circuits: ProviderCircuit[];
  constructor(private readonly providers: readonly StreamingSttProvider[], private readonly maxBufferedBytes = 480_000, circuit: FallbackCircuitOptions = {}) {
    if (!providers.length || maxBufferedBytes < 1) throw new Error("Invalid STT fallback configuration");
    this.circuits = providers.map(provider => new ProviderCircuit({ ...circuit, onChange: change => circuit.onChange?.({ provider: provider.name, ...change }) }));
  }
  capabilities() {
    const caps = this.providers.map(p => p.capabilities());
    return { languages: [...new Set(caps.flatMap(c => c.languages))], formats: caps[0].formats.filter(f => caps.every(c => c.formats.some(other => other.encoding === f.encoding && other.sampleRate === f.sampleRate && other.channels === f.channels))),
      interimResults: caps.every(c => c.interimResults), providerEndpointing: caps.every(c => c.providerEndpointing),
      reportsConfidence: caps.every(c => c.reportsConfidence) };
  }
  open(options: SttStreamOptions, listener: (event: SttEvent) => void): SttStream {
    const providers = this.providers.map((provider, at) => ({ provider, circuit: this.circuits[at] })).filter(({ provider: p }) => p.capabilities().formats.some(f => f.encoding === options.format.encoding && f.sampleRate === options.format.sampleRate && f.channels === options.format.channels));
    let active: SttStream | undefined, index = -1, generation = 0, closed = false, finalized = false, overflow = false;
    let buffered: Uint8Array[] = [], bytes = 0, pendingFinalize = false;
    // The circuit of the provider now streaming, until it has a verdict.
    let trial: ProviderCircuit | undefined;
    const settle = (verdict: "success" | "failure" | "release") => { const circuit = trial; trial = undefined; circuit?.[verdict](); };
    const closeActive = () => { try { void active?.close().catch(() => {}); } catch { /* A broken vendor must not crash cleanup. */ } };
    const fail = (event: SttEvent) => {
      if (closed) return;
      closed = true; generation++; closeActive(); buffered = []; settle("release");
      listener(event); listener({ type: "closed" });
    };
    const write = (audio: Uint8Array) => {
      try { active?.write(audio); } catch { fail({ type: "error", code: "provider", message: "STT write failed", retryable: false }); }
    };
    const finalize = () => {
      try { active?.finalize(); } catch { fail({ type: "error", code: "provider", message: "STT finalize failed", retryable: false }); }
    };
    const start = () => {
      index++;
      // Skip a provider whose circuit is open; the last compatible one is always tried.
      while (index + 1 < providers.length && !providers[index].circuit.acquire()) index++;
      const current = ++generation;
      if (!providers[index]) { fail({ type: "error", code: "provider", message: "No compatible STT provider", retryable: false }); return; }
      if (index > 0) observe("voice.fallback", { component: "voice", operation: "stt", provider: providers[index].provider.name });
      active = undefined; trial = index + 1 < providers.length ? providers[index].circuit : undefined;
      try {
        active = providers[index].provider.open(options, event => queueMicrotask(() => {
          if (closed || current !== generation) return;
          if (event.type === "error" || event.type === "closed") {
            const recoverable = event.type === "closed" || event.retryable;
            // Only an outage counts against the provider, including one that drops a stream it had been serving.
            if (recoverable) { trial ??= index + 1 < providers.length ? providers[index].circuit : undefined; settle("failure"); }
            if (recoverable && !finalized && !overflow && index + 1 < providers.length) {
              generation++; closeActive(); start();
              if (!closed) { for (const audio of buffered) { if (!closed) write(audio); } if (!closed && pendingFinalize) finalize(); }
            } else fail(event.type === "error" ? event : { type: "error", code: "provider", message: "STT stream closed", retryable: true });
            return;
          }
          settle("success");
          if (event.type === "final") { finalized = true; buffered = []; bytes = 0; }
          listener(event.type === "final" ? { ...event, utteranceId: `${index}:${event.utteranceId}` } : event);
        }));
      } catch {
        fail({ type: "error", code: "provider", message: "STT open failed", retryable: false });
      }
    };
    // Defer startup so a synchronous vendor error still follows the port contract.
    queueMicrotask(() => { if (!closed) { start(); for (const audio of buffered) { if (!closed) write(audio); } if (!closed && pendingFinalize) finalize(); } });
    return {
      write: audio => {
        if (closed) return;
        if (!finalized && !overflow) {
          bytes += audio.byteLength;
          if (bytes <= this.maxBufferedBytes) buffered.push(audio.slice());
          else { overflow = true; buffered = []; }
        }
        write(audio);
      },
      finalize: () => { if (!closed) { pendingFinalize = true; finalize(); } },
      close: async () => { if (closed) return; closed = true; generation++; buffered = []; settle("release"); await active?.close(); listener({ type: "closed" }); },
    };
  }
}
