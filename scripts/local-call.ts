/**
 * HALO Phase 4.5 Sprint 1 — LOCAL DEVELOPMENT CLIENT. Not a service.
 *
 *   npx tsx scripts/local-call.ts [--gateway http://127.0.0.1:8787] [--from +91…] [--to +91…]
 *
 * This is a laptop pretending to be a phone carrier. It places one call
 * against a running voice gateway over the EXISTING fake-carrier protocol —
 * HMAC-signed webhook, minted stream token, `/media` socket, JSON lines
 * carrying base64 μ-law 8 kHz — and puts a real microphone and a real
 * speaker on the ends of it.
 *
 *     mic ─▶ resample to 8 kHz ─▶ μ-law ─▶ /media ─▶ HALO ─▶ μ-law ─▶ speaker
 *
 * WHAT IT PROVES: vendors, the model, Telugu behaviour and real latency —
 * the things that are currently unmeasurable.
 *
 * WHAT IT DOES NOT PROVE: telephony. There is no PSTN transport, no carrier
 * jitter, no packet loss and no Pipecat worker. A good demo here is NOT a
 * working phone call, and must never be reported as one.
 *
 * It adds nothing to the platform: no new server, no second voice path, no
 * change under `packages/`. Everything it speaks is a protocol the gateway
 * already accepts from `FakeTelephonyProvider`.
 *
 * Audio I/O is delegated to whatever recorder/player is on the machine
 * (`sox`, ALSA, ffmpeg), because a dev tool should not pull a native audio
 * module into the repository. See docs/LOCAL_VOICE_LOOP.md.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { linearToMulaw, mulawToLinear } from "@halo/voice/audio";

// --- configuration ---------------------------------------------------------

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index > -1 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : fallback;
}

function has(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

const GATEWAY = arg("gateway", process.env.HALO_LOCAL_GATEWAY ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
/** The public URL the gateway signs webhooks against — must match its config. */
const PUBLIC_BASE = arg("public-url", process.env.VOICE_GATEWAY_PUBLIC_WS_URL ?? "");
const FROM = arg("from", process.env.HALO_LOCAL_FROM ?? "");
const TO = arg("to", process.env.HALO_LOCAL_TO ?? "");
const SECRET = process.env.VOICE_FAKE_WEBHOOK_SECRET ?? "";
/** Rate the recorder captures at, before this script resamples to 8 kHz. */
const CAPTURE_RATE = Number.parseInt(arg("capture-rate", process.env.HALO_LOCAL_CAPTURE_RATE ?? "48000"), 10);

/** The media contract: 20 ms of μ-law 8 kHz mono per frame. */
const WIRE_RATE = 8000;
const FRAME_MS = 20;
const FRAME_SAMPLES = (WIRE_RATE * FRAME_MS) / 1000; // 160 bytes of μ-law

// --- audio conversion ------------------------------------------------------

/**
 * Anti-aliased decimation to 8 kHz.
 *
 * A laptop mic runs at 44.1/48 kHz and the media contract is 8 kHz, so
 * something must resample. It happens HERE, in the dev client, and never in
 * `packages/voice/audio.ts`: the media contract is not negotiable just
 * because the hardware on this desk produces something else.
 *
 * Averaging over each output sample's input window is a box low-pass — crude
 * next to a windowed-sinc, but it removes the aliasing that a bare
 * take-every-Nth-sample decimation folds into the speech band, and it is
 * honest about what it is.
 */
export class Resampler {
  private carry: number[] = [];
  private readonly ratio: number;

  constructor(inputRate: number) {
    this.ratio = inputRate / WIRE_RATE;
    if (!(this.ratio >= 1)) throw new Error(`capture rate ${inputRate} is below the 8 kHz wire rate`);
  }

  /** PCM16LE at the capture rate → PCM16 samples at 8 kHz. */
  push(pcm: Buffer): Int16Array {
    for (let i = 0; i + 1 < pcm.length; i += 2) this.carry.push(pcm.readInt16LE(i));
    const outCount = Math.floor(this.carry.length / this.ratio);
    const out = new Int16Array(outCount);
    for (let i = 0; i < outCount; i++) {
      const start = Math.floor(i * this.ratio);
      const end = Math.max(start + 1, Math.floor((i + 1) * this.ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += this.carry[j];
      out[i] = Math.round(sum / (end - start));
    }
    this.carry = this.carry.slice(Math.floor(outCount * this.ratio));
    return out;
  }
}

export function toMulaw(samples: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = linearToMulaw(samples[i]);
  return out;
}

export function fromMulaw(mulaw: Buffer): Buffer {
  const out = Buffer.allocUnsafe(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) out.writeInt16LE(mulawToLinear(mulaw[i]), i * 2);
  return out;
}

// --- audio devices ---------------------------------------------------------

interface AudioTool {
  command: string;
  args: string[];
}

/**
 * Capture and playback are external processes on purpose: a development
 * script must not add a native audio dependency to the repository. Both are
 * overridable, because "which recorder works" is a property of the machine,
 * not of HALO.
 */
function recorder(): AudioTool {
  const override = process.env.HALO_LOCAL_MIC_CMD;
  if (override) return splitCommand(override);
  return { command: "sox", args: ["-q", "-d", "-t", "raw", "-b", "16", "-e", "signed-integer", "-r", String(CAPTURE_RATE), "-c", "1", "-"] };
}

function player(): AudioTool {
  const override = process.env.HALO_LOCAL_SPEAKER_CMD;
  if (override) return splitCommand(override);
  return { command: "sox", args: ["-q", "-t", "raw", "-b", "16", "-e", "signed-integer", "-r", String(WIRE_RATE), "-c", "1", "-", "-d"] };
}

function splitCommand(line: string): AudioTool {
  const parts = line.trim().split(/\s+/);
  return { command: parts[0], args: parts.slice(1) };
}

function start(tool: AudioTool, role: string): ChildProcessWithoutNullStreams {
  const child = spawn(tool.command, tool.args, { stdio: ["pipe", "pipe", "pipe"] });
  child.on("error", (error) => {
    console.error(`\n${role} failed to start (${tool.command}): ${error.message}`);
    console.error(`Install sox, or set HALO_LOCAL_${role === "microphone" ? "MIC" : "SPEAKER"}_CMD. See docs/LOCAL_VOICE_LOOP.md.`);
    process.exit(1);
  });
  // Device errors are the single most common local-setup problem; showing
  // them beats a silent call with no audio in either direction.
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.error(`[${role}] ${text}`);
  });
  return child;
}

// --- latency report --------------------------------------------------------

/**
 * Client-side observations only. The server-side chain
 * (endpoint → context_ready → llm_first_token → tts_first_byte →
 * turn_complete) is recorded by the gateway in `call_events`; this half is
 * what the gateway cannot see, because only the client knows when audio
 * actually reached the speaker.
 */
class Turns {
  private speechStartedAt: number | null = null;
  private speechEndedAt: number | null = null;
  private awaitingReply = false;
  readonly rows: Array<{ speechMs: number; toFirstAudioMs: number }> = [];

  speechStarted(at: number): void {
    if (this.speechStartedAt === null) this.speechStartedAt = at;
  }

  speechEnded(at: number): void {
    if (this.speechStartedAt === null) return;
    this.speechEndedAt = at;
    this.awaitingReply = true;
  }

  /** First byte of agent audio handed to the speaker after the caller stopped. */
  played(at: number): void {
    if (!this.awaitingReply || this.speechEndedAt === null || this.speechStartedAt === null) return;
    this.rows.push({
      speechMs: Math.round(this.speechEndedAt - this.speechStartedAt),
      toFirstAudioMs: Math.round(at - this.speechEndedAt),
    });
    this.awaitingReply = false;
    this.speechStartedAt = null;
    this.speechEndedAt = null;
  }

  report(): void {
    console.log("\n=== local loop, client-side latency (MEASURED HERE, not a vendor benchmark) ===");
    if (this.rows.length === 0) {
      console.log("no completed turns");
      return;
    }
    console.table(
      this.rows.map((row, i) => ({
        turn: i + 1,
        "speech duration (ms)": row.speechMs,
        "end of speech → first audio out of the speaker (ms)": row.toFirstAudioMs,
      })),
    );
    const sorted = [...this.rows].map((r) => r.toFirstAudioMs).sort((a, b) => a - b);
    // p50 and the worst case, not p95: a hand-driven local call produces a
    // handful of turns, and a p95 over five samples is a number that looks
    // like statistics without being any.
    console.log(`p50 ${sorted[Math.floor((sorted.length - 1) * 0.5)]} ms   worst ${sorted[sorted.length - 1]} ms   n=${sorted.length}`);
    console.log(
      "\nThis number includes local capture, this script's resampling and the\n" +
        "speaker's own buffering. The server-side breakdown (STT final, context\n" +
        "ready, LLM first token, TTS first byte) is in `call_events` for this call.\n" +
        "It contains NO PSTN transport, so it is not a phone-call latency.\n",
    );
  }
}

// --- the call --------------------------------------------------------------

function signWebhook(url: string, body: string): string {
  return createHmac("sha256", SECRET).update(`${url}\n${body}`).digest("hex");
}

/** The URL the gateway will reconstruct and verify the signature against. */
function signedUrl(path: string): string {
  if (!PUBLIC_BASE) return `${GATEWAY}${path}`;
  const url = new URL(PUBLIC_BASE);
  url.protocol = url.protocol === "ws:" ? "http:" : "https:";
  url.pathname = path;
  url.search = "";
  return url.toString();
}

async function postWebhook(path: string, payload: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify(payload);
  return fetch(`${GATEWAY}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fake-signature": signWebhook(signedUrl(path), body) },
    body,
  });
}

function requireConfig(): void {
  const missing: string[] = [];
  if (!SECRET) missing.push("VOICE_FAKE_WEBHOOK_SECRET (the same value the gateway is running with)");
  if (!FROM) missing.push("--from / HALO_LOCAL_FROM (the number you are calling from)");
  if (!TO) missing.push("--to / HALO_LOCAL_TO (a provisioned phone_numbers.e164 for the tenant)");
  if (missing.length === 0) return;
  console.error("local-call needs:");
  for (const item of missing) console.error(`  - ${item}`);
  console.error("\nThere is no default for either number: which tenant answers is a routing\nfact this script must not invent. See docs/LOCAL_VOICE_LOOP.md.");
  process.exit(1);
}

async function main(): Promise<void> {
  requireConfig();
  const providerCallId = `LOCAL-${randomUUID().slice(0, 8)}`;

  // 1. Place the call exactly as the fake carrier would.
  const inbound = await postWebhook("/telephony/fake/inbound", { type: "inbound", callId: providerCallId, from: FROM, to: TO });
  if (!inbound.ok) {
    console.error(`gateway refused the call: ${inbound.status} ${await inbound.text()}`);
    process.exit(1);
  }
  const answer = (await inbound.json()) as { action?: string; url?: string; parameters?: Record<string, string>; reason?: string };
  if (answer.action !== "connect_stream" || !answer.parameters) {
    console.error(`gateway declined: ${answer.reason ?? answer.action ?? "unknown"}`);
    console.error("Usually: the dialled number is not provisioned, the agent has no published\nversion, or that version is missing the six required voice prompts.");
    process.exit(1);
  }

  // 2. Open the media socket. The gateway's public URL may be unreachable
  //    from this laptop, so connect to the local gateway and let the stream
  //    token — which is bound to the call id and both numbers — do the
  //    authenticating. The token is the security boundary, not the host.
  const mediaUrl = `${GATEWAY.replace(/^http/, "ws")}/media`;
  const socket = new WebSocket(mediaUrl);
  const streamId = `LOCALSTREAM-${randomUUID().slice(0, 8)}`;

  const mic = start(recorder(), "microphone");
  const speaker = start(player(), "speaker");
  const resampler = new Resampler(CAPTURE_RATE);
  const turns = new Turns();
  let speaking = false;
  let silenceRunMs = 0;
  let closing = false;

  const send = (message: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  socket.on("open", () => {
    send({ event: "start", callId: providerCallId, streamId, parameters: answer.parameters });
    console.log(`\ncall ${providerCallId} connected — ${FROM} → ${TO}`);
    console.log("speak into the microphone; press Ctrl-C to hang up\n");

    mic.stdout.on("data", (chunk: Buffer) => {
      const samples = resampler.push(chunk);
      // Local speech marks, for this script's own timing only. HALO does its
      // own endpointing server-side and is not told anything by these.
      let energy = 0;
      for (const sample of samples) energy += (sample / 32768) ** 2;
      const rms = samples.length > 0 ? Math.sqrt(energy / samples.length) : 0;
      const ms = (samples.length / WIRE_RATE) * 1000;
      if (rms > 0.02) {
        silenceRunMs = 0;
        if (!speaking) {
          speaking = true;
          turns.speechStarted(Date.now());
        }
      } else if (speaking) {
        silenceRunMs += ms;
        if (silenceRunMs >= 500) {
          speaking = false;
          turns.speechEnded(Date.now() - silenceRunMs);
        }
      }

      const mulaw = toMulaw(samples);
      // Frame at the media contract's 20 ms, not at whatever size the
      // recorder happens to hand over.
      for (let offset = 0; offset + FRAME_SAMPLES <= mulaw.length; offset += FRAME_SAMPLES) {
        send({ event: "media", payload: mulaw.subarray(offset, offset + FRAME_SAMPLES).toString("base64") });
      }
    });
  });

  socket.on("message", (data: Buffer) => {
    let message: { event?: string; payload?: string; name?: string };
    try {
      message = JSON.parse(data.toString()) as typeof message;
    } catch {
      return;
    }
    switch (message.event) {
      case "media": {
        if (typeof message.payload !== "string") return;
        turns.played(Date.now());
        speaker.stdin.write(fromMulaw(Buffer.from(message.payload, "base64")));
        return;
      }
      case "clear":
        // Barge-in: HALO cancelled the reply. A real carrier drops its
        // playout buffer here. This script cannot un-write audio already
        // handed to the OS, so some tail will still be heard — a local-loop
        // artefact, not a HALO one.
        console.log("  [barge-in: agent audio cancelled]");
        return;
      case "mark":
        // Acknowledge playback so the session settles the turn. Echoing
        // immediately over-reports delivery by the speaker's buffer depth;
        // the gateway's mark grace covers the difference.
        send({ event: "mark", name: message.name });
        return;
      default:
        return;
    }
  });

  socket.on("error", (error: Error) => console.error(`media socket error: ${error.message}`));
  socket.on("close", (code: number, reason: Buffer) => {
    if (!closing) console.error(`\nmedia socket closed by the gateway: ${code} ${reason.toString() || ""}`.trimEnd());
    void hangUp("media_closed");
  });

  async function hangUp(why: string): Promise<void> {
    if (closing) return;
    closing = true;
    console.log(`\nhanging up (${why})`);
    send({ event: "stop" });
    mic.kill("SIGTERM");
    speaker.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 200));
    socket.close();
    // Tell the gateway the leg ended, as a carrier would, so the call is
    // finalized rather than left to its duration ceiling.
    try {
      await postWebhook("/telephony/fake/status", { type: "status", callId: providerCallId, status: "completed" });
    } catch {
      // The gateway may already be gone; the call still finalizes on its side.
    }
    turns.report();
    process.exit(0);
  }

  process.on("SIGINT", () => void hangUp("caller hung up"));
  process.on("SIGTERM", () => void hangUp("terminated"));
}

/**
 * Only place a call when this file is the program. The audio conversion
 * above is exported so it can be tested; importing it must never dial.
 */
const isEntryPoint = process.argv[1]?.endsWith("local-call.ts") === true;

if (!isEntryPoint) {
  // imported for its exports
} else if (has("help")) {
  console.log(
    [
      "HALO local voice loop — development client (not a service)",
      "",
      "  npx tsx scripts/local-call.ts --from +919000000001 --to +914000000001",
      "",
      "  --gateway       gateway base URL (default http://127.0.0.1:8787)",
      "  --public-url    the gateway's VOICE_GATEWAY_PUBLIC_WS_URL, if it differs",
      "  --from --to     caller and dialled numbers (--to must be provisioned)",
      "  --capture-rate  microphone rate before resampling (default 48000)",
      "",
      "Environment: VOICE_FAKE_WEBHOOK_SECRET, HALO_LOCAL_MIC_CMD, HALO_LOCAL_SPEAKER_CMD",
      "Full setup and troubleshooting: docs/LOCAL_VOICE_LOOP.md",
    ].join("\n"),
  );
} else {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
