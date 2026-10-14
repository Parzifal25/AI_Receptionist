import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * A local stand-in for Sarvam's two realtime sockets, for tests that need the
 * REAL adapters and the real `ws` client to see an outage and a recovery.
 * It listens on loopback only and speaks just enough of each documented
 * protocol for one utterance: TTS answers a `flush` with one audio frame and
 * the completion event; STT sends `session.begin` and answers a `flush` with
 * one final. It says nothing about the vendor's accuracy, latency or limits.
 *
 * `mode` is what the next connection meets:
 *   - `healthy`       the upgrade is accepted and requests are answered;
 *   - `unavailable`   the upgrade is refused with 503 (a recoverable failure);
 *   - `hang`          the TCP connection is accepted and never answered;
 *   - `unauthorized`  the upgrade is refused with 401 (never recoverable);
 *   - `bad_voice`     TTS answers with a vendor error naming the speaker.
 */
export type SimSarvamMode = "healthy" | "unavailable" | "hang" | "unauthorized" | "bad_voice";

/** What a healthy TTS request is answered with: 100 ms of 8 kHz PCM16, non-zero. */
export const SIM_TTS_AUDIO = new Uint8Array(1_600).fill(7);
export const SIM_STT_TEXT = "నమస్కారం";

export class SimSarvam {
  mode: SimSarvamMode = "healthy";
  /** Connection attempts that reached the endpoint, whatever their outcome. */
  readonly attempts = { tts: 0, stt: 0 };
  private readonly server = http.createServer();
  private readonly sockets = new WebSocketServer({ noServer: true });
  private readonly raw = new Set<Duplex>();
  private held: Promise<void> = Promise.resolve();
  private waiters: (() => void)[] = [];

  static async start(): Promise<SimSarvam> {
    const sim = new SimSarvam();
    await new Promise<void>(resolve => sim.server.listen(0, "127.0.0.1", resolve));
    return sim;
  }

  private constructor() {
    this.server.on("upgrade", (request, socket, head) => {
      const kind = request.url?.startsWith("/text-to-speech/ws") ? "tts" : request.url?.startsWith("/speech-to-text-realtime/ws") ? "stt" : null;
      this.raw.add(socket); socket.on("close", () => this.raw.delete(socket)); socket.on("error", () => {});
      if (!kind) { refuse(socket, 404, "Not Found"); return; }
      this.attempts[kind] += 1;
      for (const wake of this.waiters.splice(0)) wake();
      if (this.mode === "hang") return;
      if (this.mode === "unavailable") { refuse(socket, 503, "Service Unavailable"); return; }
      if (this.mode === "unauthorized") { refuse(socket, 401, "Unauthorized"); return; }
      const mode = this.mode;
      this.sockets.handleUpgrade(request, socket, head, ws => (kind === "tts" ? this.serveTts(ws, mode) : this.serveStt(ws)));
    });
  }

  get baseUrl(): string { return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`; }

  /** Healthy requests wait for the returned release: a slow vendor on demand. */
  hold(): () => void {
    let release: () => void = () => {};
    this.held = new Promise(resolve => { release = resolve; });
    return release;
  }

  /** Resolves once `kind` has been attempted `count` times in total. */
  async reached(kind: "tts" | "stt", count: number): Promise<void> {
    while (this.attempts[kind] < count) await new Promise<void>(resolve => this.waiters.push(resolve));
  }

  /** The vendor drops every live connection without a close handshake. */
  dropAll(): void { for (const socket of this.raw) socket.destroy(); }

  async stop(): Promise<void> {
    this.dropAll();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  private serveTts(ws: WebSocket, mode: SimSarvamMode): void {
    ws.on("message", data => {
      if (parse(data).type !== "flush") return;
      void this.held.then(() => {
        if (ws.readyState !== ws.OPEN) return;
        if (mode === "bad_voice") { ws.send(JSON.stringify({ type: "error", data: { code: "invalid_speaker", message: "unknown speaker" } })); return; }
        ws.send(JSON.stringify({ type: "audio", data: { audio: Buffer.from(SIM_TTS_AUDIO).toString("base64") } }));
        ws.send(JSON.stringify({ type: "event", data: { event_type: "final" } }));
      });
    });
  }

  private serveStt(ws: WebSocket): void {
    let utterance = 0;
    ws.send(JSON.stringify({ event: "session.begin", request_id: `sim-${this.attempts.stt}` }));
    ws.on("message", data => {
      const event = parse(data).event;
      if (event === "end") { ws.close(1000); return; }
      if (event !== "flush") return;
      void this.held.then(() => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event: "transcript.final", text: SIM_STT_TEXT, utterance_idx: utterance++ }));
      });
    });
  }
}

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function parse(data: unknown): { type?: unknown; event?: unknown } {
  try { return JSON.parse(String(data)) as { type?: unknown; event?: unknown }; } catch { return {}; }
}
