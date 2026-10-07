import { linearToMulaw, mulawToLinear } from "@halo/voice/audio";

/** What the HALO server offers for one live voice session. */
export interface LiveCallOffer {
  mediaUrl: string;
  format: { encoding: string; sampleRate: number; channels: number };
  start: { event: "start"; callId: string; streamId: string; parameters: Record<string, string> };
}

export type LiveCallState = "connecting" | "live" | "ended";
export type LiveCallError = "not-allowed" | "audio-capture" | "halo-unavailable";

export interface LiveCallCallbacks {
  onState(state: LiveCallState): void;
  onError(code: LiveCallError): void;
}

/**
 * A live, full-duplex voice session with HALO's Pipecat media socket.
 *
 * The browser is only the microphone and the speaker. It streams captured
 * audio in the session's wire format and plays whatever arrives; speech
 * recognition, turn-taking, interruption and every spoken word are decided
 * server-side. No Web Speech API is involved.
 *
 * Wire protocol (the one a carrier speaks to the same socket), JSON text:
 *   → start, media{payload}, mark{name}, stop
 *   ← media{payload}, clear (barge-in: drop queued audio), mark{name}
 */
export class LiveCall {
  private socket?: WebSocket;
  private stream?: MediaStream;
  private context?: AudioContext;
  private processor?: ScriptProcessorNode;
  private source?: MediaStreamAudioSourceNode;
  private playing = new Set<AudioBufferSourceNode>();
  private marks = new Set<ReturnType<typeof setTimeout>>();
  private playhead = 0;
  private ended = false;

  constructor(private readonly offer: LiveCallOffer, private readonly callbacks: LiveCallCallbacks) {}

  static isSupported(): boolean {
    return typeof window !== "undefined" && window.isSecureContext !== false && !!navigator.mediaDevices?.getUserMedia &&
      !!window.AudioContext && typeof WebSocket !== "undefined";
  }

  async start(): Promise<void> {
    const { format } = this.offer;
    if (format.encoding !== "mulaw" || format.channels !== 1) return this.fail("halo-unavailable");
    this.callbacks.onState("connecting");
    try {
      // Echo cancellation keeps HALO's own voice out of the microphone, so
      // only the visitor's speech can interrupt a reply.
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.ended) return this.release();
      this.context = new AudioContext();
      await this.context.resume();
      if (this.context.state !== "running") throw new Error("audio-capture");
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      return this.fail(name === "NotAllowedError" || name === "SecurityError" ? "not-allowed" : "audio-capture");
    }
    if (this.ended) return this.release();
    const socket = new WebSocket(this.offer.mediaUrl);
    this.socket = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify(this.offer.start));
      this.capture(socket);
      this.callbacks.onState("live");
    };
    socket.onmessage = (event) => { if (typeof event.data === "string") this.receive(event.data); };
    socket.onerror = () => this.fail("halo-unavailable");
    socket.onclose = () => this.finish();
  }

  /** Hang up. Safe to call more than once. */
  stop(): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ event: "stop" }));
    this.finish();
  }

  private capture(socket: WebSocket): void {
    const context = this.context!, rate = this.offer.format.sampleRate;
    // Whole input samples per wire sample: averaging the window low-passes
    // before decimating, so hardware-rate audio is never mislabelled.
    const step = context.sampleRate / rate;
    let carry = new Float32Array(0);
    this.source = context.createMediaStreamSource(this.stream!);
    this.processor = context.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (event) => {
      if (this.ended || socket.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      const samples = new Float32Array(carry.length + input.length);
      samples.set(carry); samples.set(input, carry.length);
      const count = Math.floor(samples.length / step);
      const bytes = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        const from = Math.floor(i * step), to = Math.max(from + 1, Math.floor((i + 1) * step));
        let sum = 0; for (let j = from; j < to; j++) sum += samples[j];
        bytes[i] = linearToMulaw(Math.round(Math.max(-1, Math.min(1, sum / (to - from))) * 32767));
      }
      carry = samples.slice(Math.floor(count * step));
      if (count) socket.send(JSON.stringify({ event: "media", payload: toBase64(bytes) }));
    };
    this.source.connect(this.processor);
    this.processor.connect(context.destination); // the processor outputs silence
  }

  private receive(raw: string): void {
    let message: { event?: string; payload?: string; name?: string };
    try { message = JSON.parse(raw); } catch { return; }
    const context = this.context;
    if (!context || this.ended) return;
    if (message.event === "media" && typeof message.payload === "string") {
      const bytes = fromBase64(message.payload);
      if (!bytes.length) return;
      const buffer = context.createBuffer(1, bytes.length, this.offer.format.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < bytes.length; i++) samples[i] = mulawToLinear(bytes[i]) / 32768;
      const node = context.createBufferSource();
      node.buffer = buffer; node.connect(context.destination);
      // Chunks arrive paced at speaking speed; a small lead absorbs jitter.
      this.playhead = Math.max(this.playhead, context.currentTime + 0.06);
      node.start(this.playhead);
      this.playhead += buffer.duration;
      this.playing.add(node);
      node.onended = () => this.playing.delete(node);
    } else if (message.event === "clear") {
      // Barge-in: HALO cut the reply. Nothing already queued may play.
      this.dropPlayback();
    } else if (message.event === "mark" && typeof message.name === "string") {
      // Acknowledge only once everything queued before the mark has played:
      // HALO records a line as heard from exactly this acknowledgement.
      const name = message.name, delay = Math.max(0, (this.playhead - context.currentTime) * 1000);
      const timer = setTimeout(() => {
        this.marks.delete(timer);
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ event: "mark", name }));
      }, delay);
      this.marks.add(timer);
    }
  }

  private dropPlayback(): void {
    for (const timer of this.marks) clearTimeout(timer);
    this.marks.clear();
    for (const node of this.playing) { node.onended = null; try { node.stop(); } catch { /* already stopped */ } }
    this.playing.clear();
    this.playhead = 0;
  }

  private fail(code: LiveCallError): void {
    if (this.ended) return;
    console.warn("HALO live voice failure", { code }); // no audio, transcript, URL or credentials
    this.callbacks.onError(code);
    this.finish();
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.release();
    this.callbacks.onState("ended");
  }

  private release(): void {
    this.dropPlayback();
    this.processor?.disconnect(); this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== "closed") void this.context.close().catch(() => {});
    const socket = this.socket;
    if (socket && socket.readyState <= WebSocket.OPEN) { socket.onclose = null; socket.onerror = null; socket.close(); }
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(payload: string): Uint8Array {
  try { return Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)); } catch { return new Uint8Array(0); }
}
