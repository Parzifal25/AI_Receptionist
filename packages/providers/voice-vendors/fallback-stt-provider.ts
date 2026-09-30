import type { StreamingSttProvider, SttEvent, SttStream, SttStreamOptions } from "@halo/ports/streaming-stt-provider";

/** Bounded startup fallback. Audio is replayed only before the first final.
 * Once a final may have caused a business action, failure is surfaced instead
 * of replaying audio into a different recognizer and duplicating the action. */
export class FallbackSttProvider implements StreamingSttProvider {
  readonly name = "fallback-stt";
  constructor(private readonly providers: readonly StreamingSttProvider[], private readonly maxBufferedBytes = 480_000) {
    if (!providers.length || maxBufferedBytes < 1) throw new Error("Invalid STT fallback configuration");
  }
  capabilities() {
    const caps = this.providers.map(p => p.capabilities());
    return { languages: [...new Set(caps.flatMap(c => c.languages))], formats: caps[0].formats.filter(f => caps.every(c => c.formats.some(other => other.encoding === f.encoding && other.sampleRate === f.sampleRate && other.channels === f.channels))),
      interimResults: caps.every(c => c.interimResults), providerEndpointing: caps.every(c => c.providerEndpointing),
      reportsConfidence: caps.every(c => c.reportsConfidence) };
  }
  open(options: SttStreamOptions, listener: (event: SttEvent) => void): SttStream {
    const providers = this.providers.filter(p => p.capabilities().formats.some(f => f.encoding === options.format.encoding && f.sampleRate === options.format.sampleRate && f.channels === options.format.channels));
    let active: SttStream | undefined, index = -1, generation = 0, closed = false, finalized = false, overflow = false;
    let buffered: Uint8Array[] = [], bytes = 0, pendingFinalize = false;
    const closeActive = () => { try { void active?.close().catch(() => {}); } catch { /* A broken vendor must not crash cleanup. */ } };
    const fail = (event: SttEvent) => {
      if (closed) return;
      closed = true; generation++; closeActive(); buffered = [];
      listener(event); listener({ type: "closed" });
    };
    const write = (audio: Uint8Array) => {
      try { active?.write(audio); } catch { fail({ type: "error", code: "provider", message: "STT write failed", retryable: false }); }
    };
    const finalize = () => {
      try { active?.finalize(); } catch { fail({ type: "error", code: "provider", message: "STT finalize failed", retryable: false }); }
    };
    const start = () => {
      index++; const current = ++generation;
      if (!providers[index]) { fail({ type: "error", code: "provider", message: "No compatible STT provider", retryable: false }); return; }
      active = undefined;
      try {
        active = providers[index].open(options, event => queueMicrotask(() => {
          if (closed || current !== generation) return;
          if (event.type === "error" || event.type === "closed") {
            if (!finalized && !overflow && index + 1 < providers.length) {
              generation++; closeActive(); start();
              if (!closed) { for (const audio of buffered) { if (!closed) write(audio); } if (!closed && pendingFinalize) finalize(); }
            } else fail(event.type === "error" ? event : { type: "error", code: "provider", message: "STT stream closed", retryable: true });
            return;
          }
          if (event.type === "final") { finalized = true; buffered = []; bytes = 0; }
          listener(event.type === "final" ? { ...event, utteranceId: `${index}:${event.utteranceId}` } : event);
        }));
      } catch {
        if (!finalized && !overflow && index + 1 < providers.length) start();
        else fail({ type: "error", code: "provider", message: "STT open failed", retryable: true });
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
      close: async () => { if (closed) return; closed = true; generation++; buffered = []; await active?.close(); listener({ type: "closed" }); },
    };
  }
}
