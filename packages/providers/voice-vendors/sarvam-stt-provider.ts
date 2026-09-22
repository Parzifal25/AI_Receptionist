import type {
  AudioFormat,
  SttCapabilities,
  SttErrorCode,
  SttEvent,
  SttStream,
  SttStreamOptions,
  StreamingSttProvider,
} from "@halo/ports/streaming-stt-provider";
import { wsSocketFactory, type SocketFactory, type VendorSocket } from "./websocket";

/**
 * HALO Phase 4.5 Sprint 1 — real streaming STT behind `StreamingSttProvider`.
 *
 * Vendor: Sarvam AI realtime speech-to-text
 * (`wss://api.sarvam.ai/speech-to-text-realtime/ws`). Chosen for ONE reason
 * the alternatives fail: it accepts μ-law 8 kHz telephony audio *and*
 * documents Telugu plus code-mixed Indian-language input on the same
 * endpoint. (Deepgram nova-3 transcribes Telugu, but its `language=multi`
 * code-switching set does not include Telugu — so Tenglish inside one
 * utterance is not available there.)
 *
 * PROTOCOL SOURCE: the vendor's published realtime WebSocket reference. It
 * has NOT been exercised against the live endpoint from this repository —
 * no credentials exist here. Everything below is the documented contract,
 * covered by offline protocol tests through the injectable `SocketFactory`.
 * See docs/KNOWN_LIMITATIONS.md before reading any Telugu claim into this.
 *
 * Honest capability notes, because they change HALO behaviour:
 *   - the endpoint emits NO per-utterance transcription confidence (only a
 *     language-detection confidence, which is a different quantity). This
 *     adapter therefore reports `confidence: null` always and declares
 *     `reportsConfidence: false`. It does not launder language confidence
 *     into transcript confidence: doing so would silently switch on HALO's
 *     read-back of misheard names and numbers on evidence that does not
 *     exist.
 *   - `language` is only reported by the vendor under auto-detection, so
 *     this adapter asks for auto-detection whenever the session declares
 *     alternative languages (the code-switching case) and reports the
 *     primary language as `null` otherwise rather than echoing back the
 *     value it was configured with.
 */

const DEFAULT_BASE_URL = "wss://api.sarvam.ai";
const DEFAULT_MODEL = "saaras:v3-realtime";
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
/** Audio accepted while the socket is still opening (~2 s of μ-law 8 kHz). */
const DEFAULT_MAX_PENDING_BYTES = 16_000;

/** Vendor-documented `language_code` values. `auto` is detection, not a language. */
export const SARVAM_STT_LANGUAGES = [
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
 * Vendor output mode. `transcribe` returns the utterance in its own script;
 * `codemix` returns mixed-script input as the vendor's code-mixed rendering.
 * Which one reads better for a Telugu/English caller is an open question
 * that needs real audio — it is configuration, not a code change.
 */
export type SarvamSttMode = "transcribe" | "verbatim" | "translit" | "codemix";

export interface SarvamSttOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  mode?: SarvamSttMode;
  streamType?: "fast" | "balanced";
  connectTimeoutMs?: number;
  maxPendingBytes?: number;
  /** Injected by tests; production uses the `ws` client. */
  connect?: SocketFactory;
  now?: () => number;
}

interface SarvamMessage {
  event?: unknown;
  text?: unknown;
  language?: unknown;
  utterance_idx?: unknown;
  request_id?: unknown;
  code?: unknown;
  message?: unknown;
  is_fatal?: unknown;
}

export class SarvamSttProvider implements StreamingSttProvider {
  readonly name = "sarvam-stt";

  constructor(private readonly options: SarvamSttOptions) {
    if (!options.apiKey) throw new Error("SarvamSttProvider requires an API key");
  }

  capabilities(): SttCapabilities {
    return {
      languages: [...SARVAM_STT_LANGUAGES],
      formats: [
        { encoding: "mulaw", sampleRate: 8000, channels: 1 },
        { encoding: "pcm16le", sampleRate: 8000, channels: 1 },
        { encoding: "pcm16le", sampleRate: 16000, channels: 1 },
      ],
      interimResults: true,
      // The vendor emits vad.speech_start / vad.speech_end with endpointing=vad.
      providerEndpointing: true,
      // No transcript confidence is emitted by this endpoint. See the header.
      reportsConfidence: false,
    };
  }

  open(options: SttStreamOptions, listener: (event: SttEvent) => void): SttStream {
    return new SarvamSttStream(this.options, options, listener);
  }
}

class SarvamSttStream implements SttStream {
  private socket: VendorSocket | null = null;
  private opened = false;
  private closed = false;
  private pending: Array<{ frame: string; bytes: number }> = [];
  private pendingBytes = 0;
  private emittedClosed = false;
  private requestId = "";
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxPendingBytes: number;

  constructor(
    private readonly vendor: SarvamSttOptions,
    private readonly stream: SttStreamOptions,
    private readonly listener: (event: SttEvent) => void,
  ) {
    this.maxPendingBytes = vendor.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    const connect = vendor.connect ?? wsSocketFactory;
    // `open()` never throws for a runtime problem (port contract): a bad URL
    // or an immediately-failing factory becomes an `error` event.
    try {
      this.socket = connect(this.url(), { "api-subscription-key": vendor.apiKey }, {
        open: () => this.onOpen(),
        message: (text) => this.onMessage(text),
        close: (code, reason) => this.onSocketClose(code, reason),
        error: (error) => this.onSocketError(error),
      });
    } catch (error) {
      this.fail("network", error instanceof Error ? error.message : "stt connect failed", true);
      return;
    }
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (!this.opened) this.fail("network", "stt connect timed out", true);
    }, vendor.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    this.connectTimer.unref?.();
  }

  write(audio: Uint8Array): void {
    if (this.closed || audio.length === 0) return;
    this.enqueue(JSON.stringify({ event: "audio_input", audio: toBase64(audio) }), audio.length);
  }

  finalize(): void {
    if (this.closed) return;
    this.enqueue(JSON.stringify({ event: "flush" }), 0);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // Tell the vendor before dropping the socket so it releases the session
    // rather than waiting out its own idle timeout.
    if (this.opened) this.socket?.send(JSON.stringify({ event: "end" }));
    this.teardown();
    this.emit({ type: "closed" });
  }

  // -------------------------------------------------------------------------

  private url(): string {
    const base = (this.vendor.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const url = new URL(`${base}/speech-to-text-realtime/ws`);
    url.searchParams.set("model", this.vendor.model ?? DEFAULT_MODEL);
    url.searchParams.set("language_code", this.languageCode());
    url.searchParams.set("mode", this.vendor.mode ?? "transcribe");
    url.searchParams.set("encoding", wireEncoding(this.stream.format));
    url.searchParams.set("sample_rate", String(this.stream.format.sampleRate));
    // Vendor-side VAD: HALO keeps its own endpointer either way, but a
    // provider endpoint is earlier and more accurate than energy alone.
    url.searchParams.set("endpointing", "vad");
    if (this.vendor.streamType) url.searchParams.set("stream_type", this.vendor.streamType);
    const keyterms = boundedKeyterms(this.stream.phraseHints);
    if (keyterms) url.searchParams.set("keyterms", keyterms);
    return url.toString();
  }

  /**
   * The vendor takes ONE language code or `auto`. A session that declares
   * alternative languages is telling us the caller may code-switch, which
   * only auto-detection can serve — and auto-detection is also the only
   * mode in which the vendor reports which language it heard.
   */
  private languageCode(): string {
    return this.stream.alternativeLanguages.length > 0 ? "auto" : this.stream.language;
  }

  private enqueue(frame: string, bytes: number): void {
    if (this.opened) {
      this.socket?.send(frame);
      return;
    }
    this.pending.push({ frame, bytes });
    this.pendingBytes += bytes;
    // Live audio: when the socket is slow to open, the NEWEST audio is the
    // audio worth keeping. Dropping the oldest keeps memory bounded without
    // losing what the caller is saying now.
    while (this.pendingBytes > this.maxPendingBytes && this.pending.length > 1) {
      this.pendingBytes -= this.pending.shift()!.bytes;
    }
  }

  private onOpen(): void {
    if (this.closed) return;
    this.opened = true;
    this.clearConnectTimer();
    const queued = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const item of queued) this.socket?.send(item.frame);
  }

  private onMessage(text: string): void {
    if (this.closed) return;
    let msg: SarvamMessage;
    try {
      msg = JSON.parse(text) as SarvamMessage;
    } catch {
      // A malformed frame is the vendor's problem, not a reason to tear down
      // a live call: drop it and keep listening.
      return;
    }
    switch (msg.event) {
      case "session.begin":
        this.requestId = str(msg.request_id) || this.requestId;
        return;
      case "vad.speech_start":
        this.emit({ type: "speech_started" });
        return;
      case "vad.speech_end":
        this.emit({ type: "endpoint" });
        return;
      case "transcript.partial": {
        const partial = str(msg.text);
        if (!partial) return;
        this.emit({ type: "partial", text: partial, language: str(msg.language) || null });
        return;
      }
      case "transcript.final": {
        const final = str(msg.text);
        if (!final) return;
        this.emit({
          type: "final",
          // Stable per utterance within this stream, so a re-sent final
          // de-duplicates in the session rather than replaying a turn.
          utteranceId: `${this.requestId || "sarvam"}:${num(msg.utterance_idx) ?? 0}`,
          text: final,
          confidence: null,
          language: str(msg.language) || null,
        });
        return;
      }
      case "error": {
        const fatal = msg.is_fatal === true;
        const code = mapErrorCode(str(msg.code), str(msg.message));
        this.emit({
          type: "error",
          code,
          message: redact(str(msg.message) || str(msg.code) || "stt provider error"),
          // The vendor's own fatality flag decides, except for credentials:
          // retrying a rejected key just burns a reconnect budget.
          retryable: !fatal && code !== "auth",
        });
        if (fatal) this.finish();
        return;
      }
      case "session.end":
        this.finish();
        return;
      default:
        // config.updated, pong, and anything the vendor adds later.
        return;
    }
  }

  private onSocketClose(code: number, reason: string): void {
    if (this.closed) return;
    // A close that HALO did not ask for is a dropped stream: report it as a
    // retryable error first so the session can reconnect, then close.
    if (code !== 1000) {
      this.emit({
        type: "error",
        code: "network",
        message: redact(`stt socket closed (${code})${reason ? `: ${reason}` : ""}`),
        retryable: true,
      });
    }
    this.finish();
  }

  private onSocketError(error: Error & { status?: number }): void {
    if (this.closed) return;
    const code = statusToCode(error.status);
    this.emit({ type: "error", code, message: redact(error.message), retryable: code !== "auth" });
    this.finish();
  }

  private fail(code: SttErrorCode, message: string, retryable: boolean): void {
    if (this.closed) return;
    this.emit({ type: "error", code, message: redact(message), retryable });
    this.finish();
  }

  /** Emit `closed` and release everything. Nothing is emitted afterwards. */
  private finish(): void {
    if (this.closed) return;
    this.teardown();
    this.emit({ type: "closed" });
  }

  private teardown(): void {
    this.closed = true;
    this.clearConnectTimer();
    this.pending = [];
    this.pendingBytes = 0;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private emit(event: SttEvent): void {
    // Port contract: ordered, and nothing after `closed`. `teardown()` sets
    // `closed` before the final emit, so this guard checks the emitted event
    // rather than the flag.
    if (this.emittedClosed) return;
    if (event.type === "closed") this.emittedClosed = true;
    this.listener(event);
  }
}

// ---------------------------------------------------------------------------

function wireEncoding(format: AudioFormat): string {
  return format.encoding === "mulaw" ? "mulaw" : "linear16";
}

function toBase64(audio: Uint8Array): string {
  return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength).toString("base64");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** Bounded, so a tenant's phrase hints can never blow up the handshake URL. */
function boundedKeyterms(hints: string[]): string {
  const out: string[] = [];
  let chars = 0;
  for (const hint of hints) {
    const term = hint.trim().replace(/[,\n\r]/g, " ");
    if (!term) continue;
    if (chars + term.length > 512) break;
    out.push(term);
    chars += term.length + 1;
    if (out.length >= 50) break;
  }
  return out.join(",");
}

export function mapErrorCode(code: string, message: string): SttErrorCode {
  const text = `${code} ${message}`.toLowerCase();
  if (/auth|unauthor|forbidden|invalid[_ -]?key|subscription/.test(text)) return "auth";
  if (/quota|rate[_ -]?limit|too many|credit|billing/.test(text)) return "quota";
  if (/language|locale/.test(text)) return "unsupported_language";
  if (/audio|encoding|sample[_ -]?rate|codec/.test(text)) return "bad_audio";
  if (/network|timeout|connect/.test(text)) return "network";
  return "provider";
}

export function statusToCode(status: number | undefined): SttErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 429 || status === 402) return "quota";
  return "network";
}

/**
 * Vendor messages are logged and persisted as call events. A credential can
 * only reach them by accident — strip anything that looks like one.
 */
function redact(message: string): string {
  return message.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]").slice(0, 200);
}
