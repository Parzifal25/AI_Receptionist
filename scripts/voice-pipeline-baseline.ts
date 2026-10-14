/**
 * HALO S3-T1 — baseline of the EXISTING Pipecat voice path, measured end to end.
 *
 *   npm run voice:baseline -- [--stt local|fake] [--tts fake|local] [--scenario all|turn|bargein-speaking|bargein-thinking|db-latency|persistence-failure]
 *                             [--calls 5] [--llm-first-token-ms 0] [--llm-token-ms 0] [--out results.json]
 *
 * What runs for real, on this machine, over localhost WebSockets:
 *
 *   scripted carrier ──μ-law 20 ms frames──▶ Python Pipecat worker (worker.py)
 *        ▲                                      Silero VAD → STT → TTS → gate → pacer
 *        └──────── μ-law media, marks, clear ◀──┘        │ control WS
 *                                                        ▼
 *                     HALO gateway server (createGatewayServer, VOICE_MEDIA_ENGINE=pipecat)
 *                     → RemoteVoiceSession → Arunodhaya SalesCallAssembly → PhoneTurnHandler
 *                     → the unchanged AgentRuntime (prompt, system actions, validation)
 *
 * What is NOT real, and is labelled so in every report line:
 *   - the model: a scripted streaming fake (`StreamingLLM`). There is no local
 *     LLM here, and paid providers are out of scope (POA $0). Its delays are
 *     parameters, never measurements.
 *   - persistence: in-memory stores. Their latency is 0 unless injected; the
 *     harness measures how many awaited writes sit on the caller's wait and
 *     what a failure does, not what a real Postgres costs.
 *   - speech with `--speech fake`: scripted transcript at the VAD endpoint and
 *     a beep TTS. `--speech local` runs the provisioned sherpa-onnx models
 *     (real local inference, credential-free) on the synthetic caller corpus.
 *   - the carrier: no PSTN, no jitter, marks echoed on receipt.
 *
 * The worker is spawned with an explicit, minimal environment (no `.env.local`,
 * no vendor key), so no paid speech provider can be selected by accident.
 *
 * Clocks: worker marks use Python's `time.monotonic()`, this script uses
 * `process.hrtime` — both CLOCK_MONOTONIC on Linux. The offset is checked at
 * start-up and reported.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import type { AgentVersion } from "@halo/core/domain/agents";
import { FakeSttProvider } from "@halo/providers/voice-fakes/fake-stt-provider";
import { FakeTelephonyProvider, signFakeWebhook } from "@halo/providers/voice-fakes/fake-telephony-provider";
import { FakeTtsProvider } from "@halo/providers/voice-fakes/fake-tts-provider";
import { InMemoryConversationStateStore } from "@halo/runtime/conversation-state";
import { ProviderKnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import type { RuntimeEvent } from "@halo/runtime/contracts";
import { linearToMulaw } from "@halo/voice/audio";
import { VoiceGateway } from "@halo/voice/gateway";
import { InMemoryCallStore } from "@halo/voice/in-memory-call-store";
import { PipecatBridge } from "@halo/voice/pipecat/bridge";
import { buildSessionConfig } from "@halo/voice/session-config";
import type { VoiceSessionEvent } from "@halo/voice/voice-session";
import { requireArunodhaya } from "@/content/tenants/arunodhaya";
import { arunodhayaSalesCallConfig } from "@/core/services/voice/arunodhaya-call";
import { SalesCallAssembly } from "@/core/services/voice/sales-call";
import { loadGatewayConfig } from "../services/voice-gateway/config";
import { createGatewayServer } from "../services/voice-gateway/server";
import { BUSINESS_A, emptyKnowledgeProvider, FakeConversationStore, StreamingLLM, type StreamStep } from "../tests/mocks/runtime-fakes";
import { InMemoryToolExecutionAuditStore } from "@halo/runtime/tools/audit";

// --- arguments ----------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index > -1 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : fallback;
}
/**
 * STT is local by default: the worker's fake STT cannot transcribe real-time
 * caller audio (see voicedClip). TTS defaults to the fake so TTS cost can be
 * separated from everything else; `--tts local` measures Piper.
 */
const STT = arg("stt", "local") as "fake" | "local";
const TTS = arg("tts", "fake") as "fake" | "local";
const SCENARIO = arg("scenario", "all");
const CALLS = Number.parseInt(arg("calls", "5"), 10);
const LLM_FIRST_TOKEN_MS = Number.parseInt(arg("llm-first-token-ms", "0"), 10);
const LLM_TOKEN_MS = Number.parseInt(arg("llm-token-ms", "0"), 10);
const OUT = arg("out", "");
// Run from the repository root (npm run voice:baseline does).
const ROOT = process.cwd();
const PYTHON = resolve(ROOT, ".venv/bin/python");
const MODEL_DIR = resolve(ROOT, "models/voice-local");
const CORPUS = resolve(ROOT, "models/local-speech-benchmark/corpus");
for (const [name, value] of [["stt", STT], ["tts", TTS]]) {
  if (!["fake", "local"].includes(value)) throw new Error(`--${name} must be fake or local`);
}

// --- clock + small helpers -------------------------------------------------------

const mono = () => Number(process.hrtime.bigint()) / 1e6;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const round = (n: number) => Math.round(n * 10) / 10;

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => ok(port));
    });
  });
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = mono() + timeoutMs;
  while (!check()) {
    if (mono() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

/**
 * Python's monotonic clock minus ours: a running Python process answers
 * pings, and the sample with the shortest round trip wins (start-up time
 * would otherwise skew a single sample). Expected ≈0 — both are CLOCK_MONOTONIC.
 */
async function clockOffsetMs(): Promise<{ offset: number; rttMs: number }> {
  const child = spawn(PYTHON, ["-I", "-u", "-c", "import sys, time\nfor _ in sys.stdin: print(time.monotonic() * 1000, flush=True)"], { stdio: ["pipe", "pipe", "ignore"] });
  let best = { offset: 0, rttMs: Infinity };
  try {
    for (let i = 0; i < 20; i++) {
      const before = mono();
      const answer = await new Promise<number>((ok) => {
        child.stdout.once("data", (chunk: Buffer) => ok(Number.parseFloat(chunk.toString())));
        child.stdin.write("ping\n");
      });
      const after = mono();
      if (after - before < best.rttMs) best = { offset: answer - (before + after) / 2, rttMs: after - before };
    }
  } finally {
    child.kill();
  }
  return best;
}

// --- caller audio ------------------------------------------------------------------

interface CallerClip {
  id: string;
  /** 20 ms μ-law frames at 8 kHz. */
  frames: Buffer[];
  firstVoiced: number;
  lastVoiced: number;
}

/** The synthetic caller corpus (Sarvam-synthesized, 16 kHz) → 8 kHz μ-law frames. */
function loadClip(id: string): CallerClip {
  const wav = readFileSync(resolve(CORPUS, `${id}.wav`));
  let offset = 12;
  let rate = 0;
  let data: Buffer | null = null;
  while (offset + 8 <= wav.length) {
    const tag = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (tag === "fmt ") rate = wav.readUInt32LE(offset + 12);
    if (tag === "data") data = wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!data || rate % 8000 !== 0) throw new Error(`unsupported clip ${id}`);
  const ratio = rate / 8000;
  const samples = new Int16Array(Math.floor(data.length / 2 / ratio));
  for (let i = 0; i < samples.length; i++) {
    let sum = 0;
    for (let j = 0; j < ratio; j++) sum += data.readInt16LE((i * ratio + j) * 2);
    samples[i] = Math.round(sum / ratio);
  }
  const frames: Buffer[] = [];
  let firstVoiced = -1;
  let lastVoiced = -1;
  for (let start = 0; start + 160 <= samples.length; start += 160) {
    let energy = 0;
    const frame = Buffer.allocUnsafe(160);
    for (let i = 0; i < 160; i++) {
      energy += (samples[start + i] / 32768) ** 2;
      frame[i] = linearToMulaw(samples[start + i]);
    }
    if (Math.sqrt(energy / 160) > 0.02) {
      if (firstVoiced < 0) firstVoiced = frames.length;
      lastVoiced = frames.length;
    }
    frames.push(frame);
  }
  return { id, frames, firstVoiced, lastVoiced };
}

/**
 * Synthetic voiced audio for `--speech fake` (the worker's fake STT ignores
 * content). Unlike the corpus, it has no pauses: the worker's VadRunner
 * re-emits `speech_started` on every STOPPING→SPEAKING flip, and its fake
 * STT re-arms its single scripted line on each start, so a natural clip with
 * pauses yields no transcript at all (a worker-fake artefact, recorded in the
 * baseline). Same construction as test_worker_e2e.py (which Silero scores as speech).
 */
function voicedClip(id: string, seconds: number): CallerClip {
  let seed = 11;
  const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  const frames: Buffer[] = [];
  const n = Math.round(seconds * 8000);
  const frame = Buffer.allocUnsafe(160);
  for (let i = 0; i < n; i++) {
    const t = i / 8000;
    const env = 0.5 * (1 + Math.sin(2 * Math.PI * 4 * t));
    let sample = 0;
    for (const h of [1, 2, 3, 4, 5]) sample += Math.sin(2 * Math.PI * 140 * (h + 0.02 * Math.sin(2 * Math.PI * 6 * t)) * t) / h;
    const value = Math.max(-32000, Math.min(32000, Math.round(12000 * env * sample + 800 * noise())));
    frame[i % 160] = linearToMulaw(value);
    if (i % 160 === 159) frames.push(Buffer.from(frame));
  }
  return { id, frames, firstVoiced: 0, lastVoiced: frames.length - 1 };
}

const SILENCE_FRAME = Buffer.alloc(160, 0xff); // μ-law digital silence
/** The worker paces outbound audio in 60 ms frames (worker.py PACE_CHUNK_S). */
const WIRE_FRAME_MS = 60;

// --- instrumented stores (latency + failure injection, timing of every op) ------------

interface StoreOp {
  store: string;
  op: string;
  start: number;
  end: number;
  ok: boolean;
}

interface Injection {
  delayMs: number;
  /** "store.op" names that fail once each, the next time they run. */
  failOnce: Set<string>;
}

function instrument<T extends object>(target: T, store: string, ops: string[], log: StoreOp[], injection: Injection): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (typeof value !== "function" || !ops.includes(String(prop))) return value;
      return (...args: unknown[]) => {
        const start = mono();
        const run = async () => {
          if (injection.delayMs > 0) await sleep(injection.delayMs);
          const key = `${store}.${String(prop)}`;
          if (injection.failOnce.delete(key)) throw new Error(`injected failure: ${key}`);
          return (value as (...a: unknown[]) => unknown).apply(t, args);
        };
        const promise = run();
        promise.then(
          () => log.push({ store, op: String(prop), start, end: mono(), ok: true }),
          () => log.push({ store, op: String(prop), start, end: mono(), ok: false }),
        );
        return promise;
      };
    },
  });
}

// --- the worker ---------------------------------------------------------------------

interface WorkerMark {
  mark: string;
  t: number;
  [field: string]: unknown;
}

function spawnWorker(port: number, controlUrl: string, offset: number, marks: WorkerMark[]): ChildProcess {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    HALO_WORKER_HOST: "127.0.0.1",
    HALO_WORKER_PORT: String(port),
    HALO_CONTROL_URL: controlUrl,
    HALO_TELEMETRY: "stdout",
    // INFO: local_speech.py logs each utterance's audio_ms and decode_ms
    // (lengths only, never words), which separates decode from queueing.
    HALO_LOG_LEVEL: "INFO",
    VOICE_STT_PROVIDER: STT,
    VOICE_TTS_PROVIDER: TTS,
    ...(STT === "local" || TTS === "local" ? { VOICE_LOCAL_MODEL_DIR: MODEL_DIR } : {}),
  };
  const child = spawn(PYTHON, [resolve(ROOT, "services/pipecat-worker/worker.py")], { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
  let buffered = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith('{"timing"')) continue;
      const record = (JSON.parse(line) as { timing: Record<string, unknown> }).timing;
      marks.push({ ...record, mark: String(record.mark), t: Number(record.monoMs) - offset });
    }
  });
  let errBuffered = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    const t = mono();
    errBuffered += chunk.toString();
    const lines = errBuffered.split("\n");
    errBuffered = lines.pop() ?? "";
    for (const line of lines) {
      const decode = /local_stt final audio_ms=(\d+) decode_ms=(\d+)/.exec(line);
      if (decode) marks.push({ mark: "local_stt_decoded", t, audioMs: Number(decode[1]), decodeMs: Number(decode[2]) });
      if (line.trim() && process.env.HALO_BASELINE_VERBOSE) console.error(`[worker] ${line.trim()}`);
    }
  });
  return child;
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = mono() + timeoutMs;
  for (;;) {
    const open = await new Promise<boolean>((ok) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/health-probe`);
      ws.on("error", () => ok(false));
      ws.on("close", () => ok(true));
      ws.on("open", () => ws.close());
    });
    if (open) return;
    if (mono() > deadline) throw new Error("worker did not start");
    await sleep(200);
  }
}

// --- gateway -----------------------------------------------------------------------

const DID = "+914000000001";
const SECRET = "baseline-fake-webhook-secret";
const STREAM_SECRET = "baseline-stream-token-secret-at-least-32";

interface GatewayEvent {
  t: number;
  type: VoiceSessionEvent["type"];
  latencyMs: number | null;
  detail: Record<string, unknown>;
}

function arunodhayaVersion(): AgentVersion {
  const { config } = requireArunodhaya();
  return {
    id: "av-arunodhaya-baseline",
    agentId: "agent-arunodhaya",
    businessId: BUSINESS_A.id,
    version: 1,
    // Same override as the golden runner: the real tenant is blocked on
    // unresolved business approvals (DECISIONS D11). This is a synthetic
    // measurement fixture, never an activation of the tenant.
    config: { ...config, activationBlockers: [] },
    promptTemplate: config.instructions.promptTemplate,
    promptVersion: "baseline",
    model: {},
    publishedAt: "2026-10-14T00:00:00Z",
    createdBy: null,
    createdAt: "2026-10-14T00:00:00Z",
  };
}

interface Rig {
  gatewayPort: number;
  workerPort: number;
  events: GatewayEvent[];
  runtimeEvents: Array<{ t: number; type: string; detail: Record<string, unknown> }>;
  storeOps: StoreOp[];
  injection: Injection;
  llm: { abortedStreams: number; streamCalls: number };
  setScript(steps: StreamStep[], firstTokenMs: number, tokenMs: number): void;
  close(): Promise<void>;
}

async function buildRig(workerPort: number): Promise<Rig> {
  const gatewayPort = await freePort();
  const storeOps: StoreOp[] = [];
  const injection: Injection = { delayMs: 0, failOnce: new Set() };
  const events: GatewayEvent[] = [];
  const runtimeEvents: Rig["runtimeEvents"] = [];
  const llmStats = { abortedStreams: 0, streamCalls: 0 };

  const callStore = new InMemoryCallStore();
  const version = arunodhayaVersion();
  callStore.addRoute("fake", DID, {
    phoneNumberId: "pn-arunodhaya",
    business: BUSINESS_A,
    agentId: "agent-arunodhaya",
    agentStatus: "active",
    version,
    handoffNumber: null,
  });
  const timedCallStore = instrument(callStore, "call", [
    "resolveInboundRoute", "resolveCallRoute", "createOrGetCall", "getCallByProviderId", "beginCallConversation",
    "transitionCall", "appendEvents", "appendTranscript", "finalizeCall", "recordOutcome", "isSuppressed",
    "recordUsageEvent",
  ], storeOps, injection);
  const conversations = instrument(new FakeConversationStore(), "conversation", ["loadHistory", "appendMessages", "appendToolRecords"], storeOps, injection);
  const stateStore = instrument(new InMemoryConversationStateStore(), "state", ["load", "save"], storeOps, injection);

  // The model: swapped per scenario. Abort-aware, so cancellation is observable.
  let llm = new StreamingLLM([{ content: "సరే." }]);
  const llmProxy = new Proxy({} as StreamingLLM, {
    get(_t, prop) {
      if (prop === "stream") {
        return (system: string, messages: never, options: { abortSignal?: AbortSignal } = {}) => {
          llmStats.streamCalls += 1;
          options.abortSignal?.addEventListener("abort", () => (llmStats.abortedStreams += 1), { once: true });
          return llm.stream(system, messages, options as never);
        };
      }
      const value = Reflect.get(llm, prop) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(llm) : value;
    },
  });

  const assembly = new SalesCallAssembly({
    config: arunodhayaSalesCallConfig(),
    llm: llmProxy,
    knowledge: new ProviderKnowledgeResolver(emptyKnowledgeProvider()),
    conversations,
    stateStore,
    toolAudit: new InMemoryToolExecutionAuditStore(),
    events: { emit: (event: RuntimeEvent) => runtimeEvents.push({ t: mono(), type: event.type, detail: event.data }) },
  });

  const telephony = new FakeTelephonyProvider(SECRET);
  const bridge = new PipecatBridge();
  const gateway = new VoiceGateway({
    callStore: timedCallStore,
    telephony,
    stt: new FakeSttProvider(),
    tts: new FakeTtsProvider(),
    // Observe every session event at the instant it is emitted.
    createMediaSession: (request) =>
      bridge.createMediaSession({
        ...request,
        hooks: {
          ...request.hooks,
          onEvent: (event) => {
            events.push({ t: mono(), type: event.type, latencyMs: event.latencyMs, detail: event.detail as Record<string, unknown> });
            request.hooks.onEvent(event);
          },
        },
      }),
    createTurnHandler: assembly.createTurnHandler,
    computeOutcome: assembly.computeOutcome,
    sessionConfig: (ctx) => {
      const built = buildSessionConfig(ctx.route.version.config);
      if (!built.ok) throw new Error(`missing prompts: ${built.missing.join(",")}`);
      return built.config;
    },
  });
  bridge.bindGateway(gateway);
  const config = loadGatewayConfig({
    VOICE_GATEWAY_PUBLIC_WS_URL: `ws://127.0.0.1:${gatewayPort}/media`,
    VOICE_STREAM_TOKEN_SECRET: STREAM_SECRET,
    TELEPHONY_PROVIDER: "fake",
    VOICE_FAKE_WEBHOOK_SECRET: SECRET,
    VOICE_MEDIA_ENGINE: "pipecat",
    VOICE_PIPECAT_MEDIA_WS_URL: `ws://127.0.0.1:${workerPort}/media`,
  });
  const server = createGatewayServer({
    config,
    gateway,
    telephony,
    pipecat: bridge,
    canAnswer: async ({ to }) => (await callStore.resolveInboundRoute("fake", to)) !== null,
    resolveWebCallNumber: async () => null,
  });
  await server.listen(gatewayPort);

  return {
    gatewayPort,
    workerPort,
    events,
    runtimeEvents,
    storeOps,
    injection,
    llm: llmStats,
    setScript(steps, firstTokenMs, tokenMs) {
      llm = new StreamingLLM(steps, { firstTokenMs, tokenMs, name: "scripted-streaming-fake" });
    },
    close: () => server.close(),
  };
}

// --- the carrier ---------------------------------------------------------------------

interface Received {
  t: number;
  event: "media" | "clear" | "mark";
}

class Carrier {
  readonly received: Received[] = [];
  private socket!: WebSocket;
  private streaming = true;
  private queue: Buffer[] = [];
  /** When each queued caller frame actually left this process. */
  readonly sentAt = new Map<string, number[]>();

  async dial(rig: Rig, callId: string): Promise<void> {
    const body = JSON.stringify({ type: "inbound", callId, from: "+919800000001", to: DID });
    const url = `http://127.0.0.1:${rig.gatewayPort}/telephony/fake/inbound`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fake-signature": signFakeWebhook(SECRET, url, body) },
      body,
    });
    const answer = (await response.json()) as { action?: string; url?: string; parameters?: Record<string, string> };
    if (answer.action !== "connect_stream" || !answer.url || !answer.parameters) throw new Error(`gateway declined: ${JSON.stringify(answer)}`);
    this.socket = new WebSocket(`ws://127.0.0.1:${rig.workerPort}/media`);
    await new Promise<void>((ok, fail) => {
      this.socket.once("open", () => ok());
      this.socket.once("error", fail);
    });
    this.socket.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString()) as { event?: string; name?: string };
      const t = mono();
      if (message.event === "media" || message.event === "clear" || message.event === "mark") {
        this.received.push({ t, event: message.event });
      }
      // Echo marks at once: this carrier "plays" audio the instant it arrives,
      // and the worker already paces it in real time.
      if (message.event === "mark") this.send({ event: "mark", name: message.name });
    });
    this.send({ event: "start", callId, streamId: callId, parameters: answer.parameters });
    void this.pump();
  }

  private send(message: unknown): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  /** A carrier streams continuously: queued caller audio, else silence, every 20 ms. */
  private async pump(): Promise<void> {
    let next = mono();
    while (this.streaming) {
      const frame = this.queue.shift() ?? SILENCE_FRAME;
      this.send({ event: "media", payload: frame.toString("base64") });
      const tag = (frame as Buffer & { tag?: string }).tag;
      if (tag) {
        const list = this.sentAt.get(tag) ?? [];
        list.push(mono());
        this.sentAt.set(tag, list);
      }
      next += 20;
      const wait = next - mono();
      if (wait > 0) await sleep(wait);
    }
  }

  /** Queue a caller clip; returns when its last frame has been sent. */
  async say(clip: CallerClip, tag: string): Promise<{ speechStart: number; speechEnd: number }> {
    const frames = clip.frames.map((f) => Object.assign(Buffer.from(f), { tag }));
    this.queue.push(...frames);
    await waitFor(() => (this.sentAt.get(tag)?.length ?? 0) >= frames.length, 30_000, `clip ${clip.id} to send`);
    const sent = this.sentAt.get(tag)!;
    return { speechStart: sent[clip.firstVoiced], speechEnd: sent[clip.lastVoiced] + 20 };
  }

  firstMediaAfter(t: number): number | null {
    return this.received.find((r) => r.event === "media" && r.t > t)?.t ?? null;
  }

  async hangUp(): Promise<void> {
    this.send({ event: "stop" });
    this.streaming = false;
    await sleep(100);
    this.socket.close();
  }
}

// --- scenarios ---------------------------------------------------------------------------

/** Two sentences → two chunks: lets the inter-chunk gap be seen. Passes Arunodhaya validation. */
const REPLY = "సరే, సోలార్ గురించి అడిగినందుకు ధన్యవాదాలు. మీ పేరు చెప్తారా?";
const LONG_REPLY =
  "సరే, మీరు సోలార్ గురించి అడిగారు, చాలా సంతోషం. మా టీమ్ మీ ఇంటికి వచ్చి ఉచితంగా సర్వే చేస్తారు. " +
  "ఆ తర్వాతే సరైన లెక్క చెప్పగలరు. మీ పేరు చెప్తారా?";

interface TurnRecord {
  scenario: string;
  call: number;
  speechEndToVadStopMs: number | null;
  speechEndToTranscriptAtGatewayMs: number | null;
  speechEndToReplyReadyMs: number | null;
  speechEndToFirstAudioMs: number | null;
  sttAfterVadStopMs: number | null;
  agentTurnMs: number | null;
  contextMs: number | null;
  modelMs: number | null;
  validationMs: number | null;
  persistenceMs: number | null;
  hooksMs: number | null;
  modelCalls: number | null;
  speakToFirstAudioReportMs: number | null;
  gatewayTurnCompleteMs: number | null;
  chunks: number;
  chunkSynthesisMs: number[];
  interChunkGapMs: number[];
  criticalStoreOps: string[];
  replyDelivery: string | null;
  /** Local STT only: worker-logged decode time and audio length of the committed utterance's segment(s). */
  sttDecodeMs: number[];
  sttSegmentAudioMs: number[];
  /** VAD stop → decode start (segments decode one at a time, in order). */
  sttQueueMs: number | null;
  /** Things that make this turn not a clean single-utterance measurement. */
  anomalies: string[];
  loadAvg1m: number;
}

function percentile(values: number[], p: number): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]);
}

/** Wait for the session's next settled playback of `kind` after `t`. */
async function playbackSettled(rig: Rig, after: number, kind: "policy" | "reply", timeoutMs = 60_000): Promise<GatewayEvent> {
  let found: GatewayEvent | undefined;
  await waitFor(() => {
    // A superseded line is not the end of the exchange: its replacement plays next.
    found = rig.events.find((e) => e.t > after && ((e.type === "tts_complete" && e.detail.kind === kind) || (e.type === "tts_cancel" && e.detail.reason !== "superseded")));
    return found !== undefined;
  }, timeoutMs, `${kind} playback to settle`);
  return found!;
}

function loadAvg1m(): number {
  try {
    return Number.parseFloat(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
  } catch {
    return NaN;
  }
}

function analyseTurn(rig: Rig, carrier: Carrier, marks: WorkerMark[], scenario: string, call: number, speechEnd: number, windowEnd: number, callStart: number): TurnRecord {
  const inWindow = <T extends { t: number }>(list: T[]) => list.filter((e) => e.t >= speechEnd - 50 && e.t <= windowEnd);
  const ev = inWindow(rig.events);
  const mk = inWindow(marks);
  const first = (type: string) => ev.find((e) => e.type === type) ?? null;
  const vadStop = mk.find((m) => m.mark === "vad_stop") ?? null;
  const sttFinal = first("stt_final");
  const agentTurn = first("agent_turn");
  const ttsStart = ev.find((e) => e.type === "tts_start" && e.detail.kind === "reply") ?? null;
  const firstByte = first("tts_first_byte");
  const turnComplete = first("turn_complete");
  const firstAudio = carrier.firstMediaAfter(ttsStart?.t ?? speechEnd);
  const speak = mk.find((m) => m.mark === "speak_received" && ttsStart && m.t >= ttsStart.t - 5) ?? null;
  const playbackId = speak?.playbackId;
  const chunkMarks = (name: string) => mk.filter((m) => m.mark === name && m.playbackId === playbackId);
  const queued = chunkMarks("chunk_queued");
  const synthesized = chunkMarks("chunk_synthesized");
  const confirmed = chunkMarks("chunk_playout_confirmed");
  const firstAudioMarks = chunkMarks("chunk_first_audio");
  const chunkSynthesisMs = queued
    .map((q) => {
      const done = synthesized.find((s) => s.chunk === q.chunk);
      return done ? round(done.t - q.t) : NaN;
    })
    .filter(Number.isFinite);
  // Gap the caller hears between chunk n's last audio and chunk n+1's first,
  // measured at the carrier: the longest silence in the received stream
  // between consecutive chunk playout confirmations.
  // Silence the caller hears between chunk n and chunk n+1, at the carrier:
  // arrival of chunk n+1's first frame minus arrival of chunk n's last frame,
  // minus that last frame's own 60 ms of audio.
  const media = carrier.received.filter((r) => r.event === "media" && r.t >= (firstAudio ?? Infinity) && r.t <= windowEnd);
  const interChunkGapMs: number[] = [];
  for (const done of confirmed) {
    if (!firstAudioMarks.some((m) => m.chunk === Number(done.chunk) + 1)) continue;
    const lastBefore = media.filter((m) => m.t <= done.t).at(-1)?.t;
    const firstAfter = media.find((m) => m.t > done.t)?.t;
    if (lastBefore !== undefined && firstAfter !== undefined) interChunkGapMs.push(round(firstAfter - lastBefore - WIRE_FRAME_MS));
  }
  const critical = rig.storeOps.filter((o) => (o.store === "conversation" || o.store === "state") && o.start >= (sttFinal?.t ?? speechEnd) && o.end <= (ttsStart?.t ?? windowEnd));
  // Classification. A turn is "clean" only when one caller utterance became
  // exactly one final and one reply.
  const anomalies: string[] = [];
  const finals = ev.filter((e) => e.type === "stt_final");
  if (finals.length > 1) anomalies.push("split_utterance");
  const callMarks = marks.filter((m) => m.t >= callStart && m.t <= windowEnd);
  let open = false;
  let starts = 0;
  for (const m of callMarks) {
    if (m.mark === "vad_start") {
      starts += 1;
      if (open && !anomalies.includes("repeated_vad_start")) anomalies.push("repeated_vad_start");
      open = true;
    } else if (m.mark === "vad_stop") {
      if (!open && !anomalies.includes("vad_stop_without_start")) anomalies.push("vad_stop_without_start");
      open = false;
    }
  }
  void starts;
  if (sttFinal?.latencyMs !== undefined && sttFinal.latencyMs !== null && sttFinal.latencyMs > 1_500) anomalies.push("stt_slower_than_final_wait");
  if (ev.some((e) => e.type === "silence" && e.t > speechEnd && (!sttFinal || e.t < sttFinal.t))) anomalies.push("silence_reprompt_before_transcript");
  const decodes = mk.filter((m) => m.mark === "local_stt_decoded" && m.t <= (sttFinal?.t ?? windowEnd) + 50);
  const lastDecode = decodes.at(-1);
  const sttQueueMs = lastDecode && vadStop ? round(lastDecode.t - Number(lastDecode.decodeMs) - vadStop.t) : null;
  const detail = agentTurn?.detail ?? {};
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    scenario,
    call,
    speechEndToVadStopMs: vadStop ? round(vadStop.t - speechEnd) : null,
    speechEndToTranscriptAtGatewayMs: sttFinal ? round(sttFinal.t - speechEnd) : null,
    speechEndToReplyReadyMs: ttsStart ? round(ttsStart.t - speechEnd) : null,
    speechEndToFirstAudioMs: firstAudio !== null && ttsStart ? round(firstAudio - speechEnd) : null,
    sttAfterVadStopMs: sttFinal?.latencyMs ?? null,
    agentTurnMs: agentTurn?.latencyMs ?? null,
    contextMs: num(detail.contextMs),
    modelMs: num(detail.modelMs),
    validationMs: num(detail.validationMs),
    persistenceMs: num(detail.persistenceMs),
    hooksMs: num(detail.hooksMs),
    modelCalls: num(detail.modelCalls),
    speakToFirstAudioReportMs: firstByte?.latencyMs ?? null,
    gatewayTurnCompleteMs: turnComplete?.latencyMs ?? null,
    chunks: queued.length,
    chunkSynthesisMs,
    interChunkGapMs,
    criticalStoreOps: critical.map((o) => `${o.store}.${o.op}${o.ok ? "" : "(failed)"}:${round(o.end - o.start)}ms`),
    sttDecodeMs: decodes.map((d) => Number(d.decodeMs)),
    sttSegmentAudioMs: decodes.map((d) => Number(d.audioMs)),
    sttQueueMs,
    anomalies,
    loadAvg1m: loadAvg1m(),
    replyDelivery: ev.find((e) => e.type === "tts_complete" && e.detail.kind === "reply") ? "complete" : ev.find((e) => e.type === "tts_cancel") ? String(ev.find((e) => e.type === "tts_cancel")!.detail.reason) : null,
  };
}

interface ScenarioResult {
  name: string;
  label: string;
  turns: TurnRecord[];
  notes: Record<string, unknown>[];
}

async function runCall(
  rig: Rig,
  marks: WorkerMark[],
  scenario: string,
  call: number,
  clip: CallerClip,
  during?: (ctx: { carrier: Carrier; speechEnd: number }) => Promise<Record<string, unknown> | void>,
): Promise<{ turn: TurnRecord; note: Record<string, unknown> | void }> {
  const carrier = new Carrier();
  const callStart = mono();
  await carrier.dial(rig, `BASE-${scenario}-${call}-${Date.now()}`);
  await playbackSettled(rig, callStart, "policy");
  await sleep(300);
  const { speechEnd } = await carrier.say(clip, `${scenario}-${call}`);
  const note = during ? await during({ carrier, speechEnd }) : undefined;
  try {
    await playbackSettled(rig, speechEnd, "reply", 30_000);
  } catch {
    // Some scenarios never speak a reply (cancelled turn); the record says so.
  }
  await sleep(400);
  const windowEnd = mono();
  const turn = analyseTurn(rig, carrier, marks, scenario, call, speechEnd, windowEnd, callStart);
  await carrier.hangUp();
  await sleep(300);
  return { turn, note };
}

// --- main -------------------------------------------------------------------------------

async function main(): Promise<void> {
  const clock = await clockOffsetMs();
  const offset = clock.offset;
  const marks: WorkerMark[] = [];
  const workerPort = await freePort();
  // The control URL must be known before the worker starts; reserve the gateway port first.
  const rig = await buildRig(workerPort);
  const worker = spawnWorker(workerPort, `ws://127.0.0.1:${rig.gatewayPort}/pipecat/control`, offset, marks);
  // Never leave a worker behind, however this process ends.
  process.once("exit", () => worker.kill("SIGTERM"));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => process.exit(130));
  const results: ScenarioResult[] = [];
  try {
    await waitForPort(workerPort, 120_000);
    const clips = STT === "local"
      ? ["te-1", "te-2", "te-3", "mix-4", "mix-5", "mix-6", "en-7", "en-8", "en-9"].map(loadClip)
      : [1.2, 1.6, 2.0].map((sec) => voicedClip(`voiced-${sec}s`, sec));
    const clipFor = (i: number) => clips[i % clips.length];
    const want = (name: string) => SCENARIO === "all" || SCENARIO === name;
    const replySteps = (n: number, content = REPLY): StreamStep[] => Array.from({ length: n * 3 }, () => ({ content }));
    const llmLabel = `model = scripted streaming fake (first token ${LLM_FIRST_TOKEN_MS} ms, ${LLM_TOKEN_MS} ms/token) — INJECTED, not measured`;
    const speechLabel = [
      STT === "local" ? "STT = local sherpa-onnx Omnilingual 300M CTC (real local inference) on the synthetic caller corpus" : "STT = worker fake",
      TTS === "local" ? "TTS = local Piper VITS via sherpa-onnx (real local inference)" : "TTS = worker fake beep (60 ms/char, ≤2 s/chunk, near-instant)",
    ].join("; ");

    if (want("turn")) {
      rig.setScript(replySteps(CALLS), LLM_FIRST_TOKEN_MS, LLM_TOKEN_MS);
      const turns: TurnRecord[] = [];
      for (let c = 0; c < CALLS; c++) turns.push((await runCall(rig, marks, "turn", c, clipFor(c))).turn);
      results.push({ name: "turn", label: `one caller turn per call; ${speechLabel}; ${llmLabel}; stores in-memory, 0 ms`, turns, notes: [] });
    }

    if (want("db-latency")) {
      const delay = 40;
      rig.injection.delayMs = delay;
      rig.setScript(replySteps(CALLS), LLM_FIRST_TOKEN_MS, LLM_TOKEN_MS);
      const turns: TurnRecord[] = [];
      for (let c = 0; c < CALLS; c++) turns.push((await runCall(rig, marks, "db-latency", c, clipFor(c))).turn);
      rig.injection.delayMs = 0;
      results.push({ name: "db-latency", label: `as "turn" with ${delay} ms INJECTED on every store operation (mock latency; measures how many awaited writes the caller waits through)`, turns, notes: [] });
    }

    if (want("bargein-speaking")) {
      rig.setScript(replySteps(CALLS, LONG_REPLY), LLM_FIRST_TOKEN_MS, LLM_TOKEN_MS);
      const turns: TurnRecord[] = [];
      const notes: Record<string, unknown>[] = [];
      for (let c = 0; c < CALLS; c++) {
        const { turn, note } = await runCall(rig, marks, "bargein-speaking", c, clipFor(c), async ({ carrier, speechEnd }) => {
          await waitFor(() => carrier.firstMediaAfter(speechEnd + 50) !== null, 30_000, "reply audio");
          const firstAudio = carrier.firstMediaAfter(speechEnd + 50)!;
          await sleep(Math.max(0, firstAudio + 800 - mono()));
          const interruptClip = clipFor(c + 3);
          const sent = carrier.say(interruptClip, `bargein-${c}`);
          await waitFor(() => (carrier.sentAt.get(`bargein-${c}`)?.length ?? 0) > interruptClip.firstVoiced, 10_000, "barge-in speech");
          const bargeSpeechStart = carrier.sentAt.get(`bargein-${c}`)![interruptClip.firstVoiced];
          await sent;
          await sleep(500);
          const clear = carrier.received.find((r) => r.event === "clear" && r.t > bargeSpeechStart);
          const lastMedia = carrier.received.filter((r) => r.event === "media" && r.t > bargeSpeechStart && (!clear || r.t <= clear.t + 2000)).at(-1);
          const vadStart = marks.find((m) => m.mark === "vad_start" && m.t > bargeSpeechStart);
          const cutStart = marks.find((m) => m.mark === "interrupt_start" && m.t > bargeSpeechStart);
          const cutDone = marks.find((m) => m.mark === "interrupt_done" && m.t > bargeSpeechStart);
          const bargeEvent = rig.events.find((e) => e.type === "barge_in" && e.t > bargeSpeechStart);
          const mediaAfterClear = clear ? carrier.received.filter((r) => r.event === "media" && r.t > clear.t).length : null;
          return {
            speechStartToVadStartMs: vadStart ? round(vadStart.t - bargeSpeechStart) : null,
            vadStartToCutDoneMs: vadStart && cutDone ? round(cutDone.t - vadStart.t) : null,
            cutStartToCutDoneMs: cutStart && cutDone ? round(cutDone.t - cutStart.t) : null,
            speechStartToClearAtCarrierMs: clear ? round(clear.t - bargeSpeechStart) : null,
            speechStartToLastAgentAudioMs: lastMedia ? round(lastMedia.t - bargeSpeechStart) : null,
            agentMediaFramesAfterClear: mediaAfterClear,
            speechStartToGatewayBargeInMs: bargeEvent ? round(bargeEvent.t - bargeSpeechStart) : null,
            gatewayDelivery: rig.events.filter((e) => e.type === "tts_cancel" && e.t > bargeSpeechStart).map((e) => e.detail.reason),
          };
        });
        turns.push(turn);
        if (note) notes.push(note);
      }
      results.push({ name: "bargein-speaking", label: `caller talks ~800 ms into a 4-sentence reply; ${speechLabel}; ${llmLabel}`, turns, notes });
    }

    if (want("bargein-thinking")) {
      const slow = 2_500;
      rig.setScript(replySteps(CALLS), slow, LLM_TOKEN_MS);
      const turns: TurnRecord[] = [];
      const notes: Record<string, unknown>[] = [];
      for (let c = 0; c < CALLS; c++) {
        const abortedBefore = rig.llm.abortedStreams;
        const { turn, note } = await runCall(rig, marks, "bargein-thinking", c, clipFor(c), async ({ carrier, speechEnd }) => {
          const isThinking = (e: GatewayEvent) => e.type === "state_changed" && e.detail.state === "thinking" && e.t > speechEnd;
          await waitFor(() => rig.events.some(isThinking), 10_000, "thinking");
          const thinkingAt = rig.events.find(isThinking)!.t;
          await sleep(Math.max(0, thinkingAt + 300 - mono()));
          const interruptClip = clipFor(c + 3);
          const sent = carrier.say(interruptClip, `think-${c}`);
          await waitFor(() => (carrier.sentAt.get(`think-${c}`)?.length ?? 0) > interruptClip.firstVoiced, 10_000, "speech");
          const speechStart = carrier.sentAt.get(`think-${c}`)![interruptClip.firstVoiced];
          await sent;
          await sleep(2_000);
          const started = rig.events.find((e) => e.type === "speech_started" && e.t > speechStart);
          const cancelled = rig.events.find((e) => e.type === "turn_cancelled" && e.t > speechStart);
          const rerun = rig.events.find((e) => e.type === "agent_turn" && e.t > speechStart);
          return {
            speechStartToGatewaySpeechStartedMs: started ? round(started.t - speechStart) : null,
            gatewaySpeechStartedToTurnCancelledMs: started && cancelled ? round(cancelled.t - started.t) : null,
            cancelledTurnCommitted: cancelled?.detail.committed ?? null,
            modelStreamAborted: rig.llm.abortedStreams > abortedBefore,
            mergedTurnRanAfterwards: rerun !== undefined,
          };
        });
        turns.push(turn);
        if (note) notes.push(note);
      }
      results.push({ name: "bargein-thinking", label: `model first token INJECTED at ${slow} ms; caller talks 300 ms into "thinking"; ${speechLabel}`, turns, notes });
    }

    if (want("persistence-failure")) {
      const turns: TurnRecord[] = [];
      const notes: Record<string, unknown>[] = [];
      const cases = ["conversation.appendMessages", "state.save", "state.load", "conversation.loadHistory", "call.appendEvents", "call.appendTranscript"];
      for (let c = 0; c < cases.length; c++) {
        rig.setScript(replySteps(3), LLM_FIRST_TOKEN_MS, LLM_TOKEN_MS);
        const before = rig.events.length;
        const runtimeBefore = rig.runtimeEvents.length;
        rig.injection.failOnce = new Set([cases[c]]);
        const { turn } = await runCall(rig, marks, "persistence-failure", c, clipFor(c));
        const evs = rig.events.slice(before);
        const rt = rig.runtimeEvents.slice(runtimeBefore);
        const spoken = evs.filter((e) => e.type === "tts_start").map((e) => `${e.detail.kind}:${e.detail.chars}ch`);
        notes.push({
          failedOperation: cases[c],
          injectedFailureConsumed: !rig.injection.failOnce.has(cases[c]),
          runtimeOutcome: rt.find((e) => e.type === "runtime.completed") ? "completed" : rt.find((e) => e.type === "runtime.failed") ? `failed (${String(rt.find((e) => e.type === "runtime.failed")!.detail.code)})` : "none",
          degradedState: rt.find((e) => e.type === "runtime.completed")?.detail.degradedState ?? null,
          agentProviderErrors: evs.filter((e) => e.type === "provider_error").map((e) => e.detail.code),
          spokenAfterTurn: spoken.slice(1),
          storeFailures: rig.storeOps.filter((o) => !o.ok).length,
          speechEndToFirstAudioMs: turn.speechEndToFirstAudioMs,
        });
        rig.injection.failOnce = new Set();
        turns.push(turn);
      }
      results.push({ name: "persistence-failure", label: `one INJECTED store failure per call; ${speechLabel}; ${llmLabel}`, turns, notes });
    }
  } finally {
    worker.kill("SIGTERM");
    await rig.close();
  }

  // --- report --------------------------------------------------------------------------
  const summary = results.map((r) => {
    // Latency columns use CLEAN turns only (one utterance → one final → one
    // reply). Split utterances are counted, and shown in the all-turns row.
    const clean = r.turns.filter((t) => !t.anomalies.includes("split_utterance"));
    const stats = (values: number[]) => ({ n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: percentile(values, 1) });
    const col = (pick: (t: TurnRecord) => number | null) => stats(clean.map(pick).filter((v): v is number => v !== null));
    const anomalyCounts: Record<string, number> = {};
    for (const t of r.turns) for (const a of t.anomalies) anomalyCounts[a] = (anomalyCounts[a] ?? 0) + 1;
    return {
      scenario: r.name,
      label: r.label,
      turns: r.turns.length,
      cleanTurns: clean.length,
      anomalies: anomalyCounts,
      "ALL turns: speech end → first reply audio": stats(r.turns.map((t) => t.speechEndToFirstAudioMs).filter((v): v is number => v !== null)),
      "speech end → first reply audio at carrier": col((t) => t.speechEndToFirstAudioMs),
      "speech end → worker VAD stop": col((t) => t.speechEndToVadStopMs),
      "speech end → transcript at gateway": col((t) => t.speechEndToTranscriptAtGatewayMs),
      "  STT queue wait (VAD stop → decode start)": col((t) => t.sttQueueMs),
      "  STT decode (worker-logged)": col((t) => (t.sttDecodeMs.length ? t.sttDecodeMs.reduce((a, b) => a + b, 0) : null)),
      "speech end → reply handed to worker": col((t) => t.speechEndToReplyReadyMs),
      "agent turn (handler)": col((t) => t.agentTurnMs),
      "  context": col((t) => t.contextMs),
      "  model": col((t) => t.modelMs),
      "  validation": col((t) => t.validationMs),
      "  persistence (awaited)": col((t) => t.persistenceMs),
      "  hooks (awaited)": col((t) => t.hooksMs),
      "speak → first audio report (TTS start)": col((t) => t.speakToFirstAudioReportMs),
      "gateway turn_complete (its own origin)": col((t) => t.gatewayTurnCompleteMs),
      "chunk synthesis": (() => {
        const all = r.turns.flatMap((t) => t.chunkSynthesisMs);
        return { n: all.length, p50: percentile(all, 0.5), p95: percentile(all, 0.95), max: percentile(all, 1) };
      })(),
      "gap between chunks at carrier": (() => {
        const all = r.turns.flatMap((t) => t.interChunkGapMs);
        return { n: all.length, p50: percentile(all, 0.5), p95: percentile(all, 0.95), max: percentile(all, 1) };
      })(),
    };
  });
  const report = {
    harness: "scripts/voice-pipeline-baseline.ts",
    when: new Date().toISOString(),
    node: process.version,
    speech: { stt: STT, tts: TTS },
    llm: { firstTokenMs: LLM_FIRST_TOKEN_MS, tokenMs: LLM_TOKEN_MS, kind: "scripted streaming fake (injected delays)" },
    clockOffsetPythonMinusNodeMs: round(offset),
    clockProbeRttMs: round(clock.rttMs),
    summary,
    scenarios: results,
    raw: { workerMarks: marks, gatewayEvents: rig.events, runtimeEvents: rig.runtimeEvents, storeOps: rig.storeOps },
  };
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
  for (const s of summary) {
    console.log(`\n=== ${s.scenario} — ${s.label}`);
    console.log(`turns=${s.turns} clean=${s.cleanTurns} anomalies=${JSON.stringify(s.anomalies)}`);
    const rows = Object.entries(s).filter(([k]) => !["scenario", "label", "turns", "cleanTurns", "anomalies"].includes(k));
    console.table(Object.fromEntries(rows));
  }
  for (const r of results) {
    if (r.notes.length > 0) {
      console.log(`\n--- ${r.name} notes`);
      console.table(r.notes);
    }
    console.log(`\n--- ${r.name} per-turn`);
    console.table(r.turns.map((t) => ({
      call: t.call, endToAudio: t.speechEndToFirstAudioMs, vadStop: t.speechEndToVadStopMs, stt: t.sttAfterVadStopMs,
      agent: t.agentTurnMs, persist: t.persistenceMs, hooks: t.hooksMs, calls: t.modelCalls, ttsFirst: t.speakToFirstAudioReportMs,
      chunks: t.chunks, synth: t.chunkSynthesisMs.join("/"), gaps: t.interChunkGapMs.join("/"), delivery: t.replyDelivery, decode: t.sttDecodeMs.join("/"), queue: t.sttQueueMs, load: t.loadAvg1m, anomalies: t.anomalies.join(","),
      criticalOps: t.criticalStoreOps.length,
    })));
  }
  console.log(`\nclock offset (python monotonic − node hrtime): ${round(offset)} ms (already subtracted)`);
  process.exit(0);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
