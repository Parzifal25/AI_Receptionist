import type {
  AudioFormat,
  SttCapabilities,
  SttErrorCode,
  SttEvent,
  SttStream,
  SttStreamOptions,
  StreamingSttProvider,
} from "@halo/ports/streaming-stt-provider";

/**
 * Deterministic streaming STT fake (HALO Phase 3).
 *
 * It does not recognize audio. A test (or the demo simulator) drives what
 * the "recognizer" heard through the open stream's controls, while the fake
 * records exactly what the session wrote and when it asked to finalize.
 * Honours the StreamingSttProvider contract: ordered events, nothing after
 * `closed`, writes after close are no-ops, stable utterance ids.
 */

export interface FakeSttStreamControl {
  readonly options: SttStreamOptions;
  readonly bytesWritten: number;
  readonly finalizeCalls: number;
  readonly closed: boolean;
  speechStarted(): void;
  partial(text: string, language?: string | null): void;
  final(text: string, opts?: { confidence?: number | null; language?: string | null; utteranceId?: string }): string;
  endpoint(): void;
  error(code: SttErrorCode, retryable: boolean, message?: string): void;
  /** Vendor dropped the stream. */
  drop(): void;
}

export interface FakeSttOptions {
  languages?: string[];
  formats?: AudioFormat[];
  providerEndpointing?: boolean;
  reportsConfidence?: boolean;
}

export class FakeSttProvider implements StreamingSttProvider {
  readonly name = "fake-stt";
  readonly streams: FakeSttStreamControl[] = [];
  private counter = 0;

  constructor(private readonly opts: FakeSttOptions = {}) {}

  capabilities(): SttCapabilities {
    return {
      languages: this.opts.languages ?? ["te-IN", "en-IN"],
      formats: this.opts.formats ?? [
        { encoding: "mulaw", sampleRate: 8000, channels: 1 },
        { encoding: "pcm16le", sampleRate: 8000, channels: 1 },
      ],
      interimResults: true,
      providerEndpointing: this.opts.providerEndpointing ?? false,
      reportsConfidence: this.opts.reportsConfidence ?? true,
    };
  }

  /** The most recently opened stream (what a live session is using). */
  get current(): FakeSttStreamControl {
    const stream = this.streams[this.streams.length - 1];
    if (!stream) throw new Error("fake-stt: no stream opened");
    return stream;
  }

  open(options: SttStreamOptions, listener: (event: SttEvent) => void): SttStream {
    let closed = false;
    let bytesWritten = 0;
    let finalizeCalls = 0;
    const emit = (event: SttEvent) => {
      if (closed) return;
      if (event.type === "closed") closed = true;
      listener(event);
    };
    const nextId = () => `fake-utt-${++this.counter}`;
    const control: FakeSttStreamControl = {
      options,
      get bytesWritten() {
        return bytesWritten;
      },
      get finalizeCalls() {
        return finalizeCalls;
      },
      get closed() {
        return closed;
      },
      speechStarted: () => emit({ type: "speech_started" }),
      partial: (text, language = null) => emit({ type: "partial", text, language }),
      final: (text, o = {}) => {
        const utteranceId = o.utteranceId ?? nextId();
        emit({
          type: "final",
          utteranceId,
          text,
          confidence: o.confidence === undefined ? 0.92 : o.confidence,
          language: o.language === undefined ? options.language : o.language,
        });
        return utteranceId;
      },
      endpoint: () => emit({ type: "endpoint" }),
      error: (code, retryable, message = "fake stt error") => emit({ type: "error", code, message, retryable }),
      drop: () => emit({ type: "closed" }),
    };
    this.streams.push(control);
    return {
      write(audio: Uint8Array) {
        if (closed) return;
        bytesWritten += audio.length;
      },
      finalize() {
        if (!closed) finalizeCalls += 1;
      },
      async close() {
        closed = true;
      },
    };
  }
}
