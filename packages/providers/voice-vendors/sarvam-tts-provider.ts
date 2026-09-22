import type { AudioFormat } from "@halo/ports/streaming-stt-provider";
import { TtsError, type StreamingTtsProvider, type TtsCapabilities, type TtsRequest } from "@halo/ports/streaming-tts-provider";
import { wsSocketFactory, type SocketFactory, type VendorSocket } from "./websocket";

/**
 * HALO Phase 4.5 Sprint 1 — real streaming TTS behind `StreamingTtsProvider`.
 *
 * Vendor: Sarvam AI Bulbul over the streaming WebSocket
 * (`wss://api.sarvam.ai/text-to-speech/ws`). Same vendor as the STT adapter,
 * for the same reason: it is the one with a documented Telugu voice that
 * emits μ-law 8 kHz directly, so HALO's media path needs no resampling and
 * the voice protocol is untouched.
 *
 * PROTOCOL SOURCE: the vendor's published streaming reference plus its
 * reference client. NOT exercised against the live endpoint from this
 * repository — no credentials exist here. Voice quality, Telugu naturalness
 * and real first-audio latency are all UNMEASURED; see
 * docs/KNOWN_LIMITATIONS.md.
 *
 * Cancellation is the contract that matters most here: barge-in aborts
 * mid-utterance, and an adapter that keeps pulling audio after an abort
 * makes the caller talk over the agent. `synthesize` closes the socket on
 * abort and completes the iterator without throwing.
 *
 * Known cost of the port shape: `synthesize()` is one call per sentence
 * chunk, so this adapter opens one WebSocket per chunk. That is a real
 * per-chunk handshake cost on time-to-first-audio and it is measured, not
 * hidden — `tts_first_byte` includes it. Connection reuse is a Sprint 2/3
 * question; it needs a pooling design that cannot leak one call's audio
 * into another's, which is not a feasibility-sprint change.
 */

const DEFAULT_BASE_URL = "wss://api.sarvam.ai";
const DEFAULT_MODEL = "bulbul:v3";
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
/** How long the vendor gets to produce the first audio frame after `flush`. */
const DEFAULT_FIRST_AUDIO_TIMEOUT_MS = 8_000;

/** Vendor-documented `target_language_code` values for Bulbul. */
export const SARVAM_TTS_LANGUAGES = [
  "te-IN",
  "en-IN",
  "hi-IN",
  "bn-IN",
  "gu-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "od-IN",
  "pa-IN",
  "ta-IN",
] as const;

/**
 * Vendor-documented `speech_sample_rate` values. 8000 is the telephony one
 * and the only one HALO's media path asks for today.
 */
const SUPPORTED_SAMPLE_RATES = [8000, 16000, 22050, 24000] as const;

export interface SarvamTtsOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /**
   * Speaker used when the agent version configures no `ttsVoice`. There is
   * no built-in default: which voice a tenant's callers hear is a decision,
   * not a fallback, so the factory requires it explicitly.
   */
  defaultSpeaker: string;
  connectTimeoutMs?: number;
  firstAudioTimeoutMs?: number;
  /** Injected by tests; production uses the `ws` client. */
  connect?: SocketFactory;
}

interface SarvamTtsMessage {
  type?: unknown;
  data?: { audio?: unknown; message?: unknown; event_type?: unknown; code?: unknown } | null;
}

export class SarvamTtsProvider implements StreamingTtsProvider {
  readonly name = "sarvam-tts";

  constructor(private readonly options: SarvamTtsOptions) {
    if (!options.apiKey) throw new Error("SarvamTtsProvider requires an API key");
    if (!options.defaultSpeaker) throw new Error("SarvamTtsProvider requires a default speaker");
  }

  capabilities(): TtsCapabilities {
    return {
      languages: [...SARVAM_TTS_LANGUAGES],
      formats: [
        { encoding: "mulaw", sampleRate: 8000, channels: 1 },
        ...SUPPORTED_SAMPLE_RATES.map((sampleRate) => ({ encoding: "pcm16le" as const, sampleRate, channels: 1 as const })),
      ],
      // The vendor's speaker catalogue is larger and versioned per model;
      // HALO only ever uses what a tenant configured or what this
      // deployment was given, so only those are claimed here.
      voices: [this.options.defaultSpeaker],
    };
  }

  synthesize(request: TtsRequest, signal: AbortSignal): AsyncIterable<Uint8Array> {
    const options = this.options;
    return {
      [Symbol.asyncIterator]: () => synthesizeStream(options, request, signal),
    };
  }
}

// ---------------------------------------------------------------------------

async function* synthesizeStream(
  vendor: SarvamTtsOptions,
  request: TtsRequest,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array, void, undefined> {
  // Port contract: an already-aborted signal or empty text yields nothing —
  // and costs no vendor call.
  if (signal.aborted || !request.text.trim()) return;
  assertSupportedFormat(request.format);

  const queue = new ChunkQueue();
  const connect = vendor.connect ?? wsSocketFactory;
  let socket: VendorSocket | null = null;
  let opened = false;
  let firstAudio = false;
  let carry: Uint8Array | null = null;

  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const later = (ms: number, fn: () => void) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    timers.push(timer);
  };

  const onAbort = () => queue.finish();
  signal.addEventListener("abort", onAbort, { once: true });

  const release = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.length = 0;
    signal.removeEventListener("abort", onAbort);
    const open = socket;
    socket = null;
    open?.close();
  };

  try {
    socket = connect(url(vendor), { "api-subscription-key": vendor.apiKey }, {
      open: () => {
        opened = true;
        socket?.send(JSON.stringify({ type: "config", data: configFor(vendor, request) }));
        socket?.send(JSON.stringify({ type: "text", data: { text: request.text } }));
        socket?.send(JSON.stringify({ type: "flush" }));
      },
      message: (text) => {
        let msg: SarvamTtsMessage;
        try {
          msg = JSON.parse(text) as SarvamTtsMessage;
        } catch {
          // A malformed frame is not audio and not a failure worth ending a
          // reply over; the first-audio timeout still bounds the wait.
          return;
        }
        if (msg.type === "audio") {
          const audio = decodeAudio(msg.data?.audio);
          if (!audio) return;
          firstAudio = true;
          // Whole samples only (port contract): a base64 frame may split a
          // 16-bit sample, so an odd trailing byte is carried forward.
          const { emit, rest } = alignSamples(carry, audio, request.format);
          carry = rest;
          if (emit.length > 0) queue.push(emit);
          return;
        }
        if (msg.type === "event" && msg.data?.event_type === "final") {
          queue.finish();
          return;
        }
        if (msg.type === "error") {
          queue.fail(toTtsError(str(msg.data?.code), str(msg.data?.message)));
        }
      },
      close: (code, reason) => {
        // A close AFTER the completion event is a no-op (the queue is already
        // finished). A close before any audio is a failure, however polite
        // the close code: silently yielding nothing would leave the caller
        // hearing silence with no error anywhere.
        if (firstAudio) queue.finish();
        else queue.fail(new TtsError("network", redact(`tts socket closed before any audio (${code})${reason ? `: ${reason}` : ""}`), true));
      },
      error: (error) => queue.fail(fromStatus(error.status, error.message)),
    });
  } catch (error) {
    release();
    throw new TtsError("network", redact(error instanceof Error ? error.message : "tts connect failed"), true);
  }

  later(vendor.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, () => {
    if (!opened) queue.fail(new TtsError("network", "tts connect timed out", true));
  });
  later(vendor.firstAudioTimeoutMs ?? DEFAULT_FIRST_AUDIO_TIMEOUT_MS, () => {
    if (!firstAudio) queue.fail(new TtsError("network", "tts produced no audio before the deadline", true));
  });

  try {
    for (;;) {
      const chunk = await queue.next();
      if (chunk === null) return;
      if (signal.aborted) return;
      yield chunk;
    }
  } finally {
    release();
  }
}

function url(vendor: SarvamTtsOptions): string {
  const base = (vendor.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const target = new URL(`${base}/text-to-speech/ws`);
  target.searchParams.set("model", vendor.model ?? DEFAULT_MODEL);
  // Without the completion event there is no way to tell "done" from "slow",
  // and the iterator would hang until the first-audio timeout on every reply.
  target.searchParams.set("send_completion_event", "true");
  return target.toString();
}

function configFor(vendor: SarvamTtsOptions, request: TtsRequest): Record<string, unknown> {
  return {
    model: vendor.model ?? DEFAULT_MODEL,
    target_language_code: request.language,
    speaker: request.voiceId || vendor.defaultSpeaker,
    // The vendor reference client sends this as a string.
    speech_sample_rate: String(request.format.sampleRate),
    output_audio_codec: request.format.encoding === "mulaw" ? "mulaw" : "linear16",
    pace: clampRate(request.speakingRate),
    // HALO already normalizes what the model says; a second text rewrite in
    // the vendor would make the spoken words differ from the validated reply.
    enable_preprocessing: false,
  };
}

/** The port allows 0.5–2.0; the vendor's Bulbul v3 range is the same. */
function clampRate(rate: number | undefined): number {
  if (rate === undefined || !Number.isFinite(rate)) return 1;
  return Math.min(2, Math.max(0.5, rate));
}

function assertSupportedFormat(format: AudioFormat): void {
  const ok =
    format.channels === 1 &&
    ((format.encoding === "mulaw" && format.sampleRate === 8000) ||
      (format.encoding === "pcm16le" && (SUPPORTED_SAMPLE_RATES as readonly number[]).includes(format.sampleRate)));
  if (!ok) {
    throw new TtsError("provider", `sarvam-tts cannot produce ${format.encoding}@${format.sampleRate}Hz mono`, false);
  }
}

function decodeAudio(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const buffer = Buffer.from(value, "base64");
  return buffer.length > 0 ? new Uint8Array(buffer) : null;
}

/** Joins a carried byte to the next frame and holds back a new odd byte. */
export function alignSamples(
  carry: Uint8Array | null,
  audio: Uint8Array,
  format: AudioFormat,
): { emit: Uint8Array; rest: Uint8Array | null } {
  if (format.encoding === "mulaw") return { emit: audio, rest: null };
  const joined = carry && carry.length > 0 ? concat(carry, audio) : audio;
  const whole = joined.length - (joined.length % 2);
  return {
    emit: joined.subarray(0, whole),
    rest: whole === joined.length ? null : joined.subarray(whole),
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * A single-consumer queue bridging socket callbacks to the async iterator.
 * `finish()` ends the iteration cleanly (completion, abort, graceful close);
 * `fail()` surfaces a typed error to the consumer exactly once.
 */
class ChunkQueue {
  private readonly chunks: Uint8Array[] = [];
  private waiting: ((value: Uint8Array | null) => void) | null = null;
  private rejecting: ((error: unknown) => void) | null = null;
  private done = false;
  private error: unknown = null;

  push(chunk: Uint8Array): void {
    if (this.done) return;
    const resolve = this.waiting;
    if (resolve) {
      this.waiting = null;
      this.rejecting = null;
      resolve(chunk);
      return;
    }
    this.chunks.push(chunk);
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    const resolve = this.waiting;
    this.waiting = null;
    this.rejecting = null;
    if (resolve && this.chunks.length === 0) resolve(null);
  }

  fail(error: unknown): void {
    if (this.done) return;
    this.done = true;
    this.error = error;
    const reject = this.rejecting;
    this.waiting = null;
    this.rejecting = null;
    // Audio already handed over is still played; the failure surfaces once
    // the consumer has drained it.
    if (reject && this.chunks.length === 0) reject(error);
  }

  next(): Promise<Uint8Array | null> {
    const buffered = this.chunks.shift();
    if (buffered) return Promise.resolve(buffered);
    if (this.error) return Promise.reject(this.error);
    if (this.done) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.waiting = resolve;
      this.rejecting = reject;
    });
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function toTtsError(code: string, message: string): TtsError {
  const text = `${code} ${message}`.toLowerCase();
  if (/auth|unauthor|forbidden|invalid[_ -]?key|subscription/.test(text)) return new TtsError("auth", redact(message || code), false);
  if (/quota|rate[_ -]?limit|too many|credit|billing/.test(text)) return new TtsError("quota", redact(message || code), true);
  if (/speaker|voice/.test(text)) return new TtsError("unsupported_voice", redact(message || code), false);
  if (/language|locale/.test(text)) return new TtsError("unsupported_language", redact(message || code), false);
  if (/network|timeout|connect/.test(text)) return new TtsError("network", redact(message || code), true);
  return new TtsError("provider", redact(message || code || "tts provider error"), false);
}

function fromStatus(status: number | undefined, message: string): TtsError {
  if (status === 401 || status === 403) return new TtsError("auth", redact(message), false);
  if (status === 429 || status === 402) return new TtsError("quota", redact(message), true);
  return new TtsError("network", redact(message), true);
}

/** Vendor text reaches logs and call events; strip anything key-shaped. */
function redact(message: string): string {
  return message.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]").slice(0, 200);
}
