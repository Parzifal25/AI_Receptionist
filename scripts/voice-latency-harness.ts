/**
 * HALO Phase 3 — voice latency harness.
 *
 * Measures the per-stage latency budget of plan §P4.3 through the REAL media
 * loop (VoiceGateway → VoiceSession → turn handler → TTS) with deterministic
 * fakes standing in for the vendors. Vendor delays are parameters, not
 * measurements: this harness measures what HALO adds and how the pipeline
 * behaves under a given vendor profile. It does NOT measure Telugu STT/TTS,
 * PSTN transport or model latency — those need the Phase 4 vendor evaluation
 * and real credentials (docs/KNOWN_LIMITATIONS.md).
 *
 *   npx tsx scripts/voice-latency-harness.ts [--calls 20] [--turns 5]
 *     [--stt-final-ms 250] [--model-ms 600] [--tts-first-byte-ms 200]
 */
import { defaultAgentConfig, type AgentVersion } from "@halo/core/domain/agents";
import type { Business } from "@halo/core/domain/types";
import { FakeSttProvider } from "@halo/providers/voice-fakes/fake-stt-provider";
import { FakeTelephonyProvider } from "@halo/providers/voice-fakes/fake-telephony-provider";
import { FakeTtsProvider } from "@halo/providers/voice-fakes/fake-tts-provider";
import { audioDurationMs, pcm16ToMulaw } from "@halo/voice/audio";
import { VoiceGateway } from "@halo/voice/gateway";
import { InMemoryCallStore } from "@halo/voice/in-memory-call-store";
import { buildSessionConfig } from "@halo/voice/session-config";
import type { VoiceTurnHandler, VoiceTurnRequest, VoiceTurnResult } from "@halo/voice/turn-handler";
import type { VoiceOutput } from "@halo/voice/voice-session";

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number.parseInt(process.argv[index + 1] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

const CALLS = arg("calls", 20);
const TURNS = arg("turns", 5);
const STT_FINAL_MS = arg("stt-final-ms", 250);
const MODEL_MS = arg("model-ms", 600);
const TTS_FIRST_BYTE_MS = arg("tts-first-byte-ms", 200);

const BUSINESS: Business = {
  id: "bench-biz",
  name: "Bench Tenant",
  slug: "bench",
  description: "",
  industry: "",
  website: "",
  phone: "",
  email: "",
  address: "",
  businessHours: {},
  logoUrl: "",
};

const PROMPTS = {
  greeting: "Hello, this is an automated assistant speaking.",
  reprompt: "Are you still there?",
  goodbye: "Thank you, goodbye.",
  turnFailure: "Sorry, could you repeat that?",
  transferAnnounce: "Please hold.",
  transferFailed: "Nobody is available.",
};

function version(): AgentVersion {
  const config = defaultAgentConfig();
  config.voice.prompts = PROMPTS;
  config.voice.endOfSpeechMs = 400;
  return {
    id: "bench-version",
    agentId: "bench-agent",
    businessId: BUSINESS.id,
    version: 1,
    config,
    promptTemplate: "bench",
    promptVersion: "bench",
    model: {},
    publishedAt: new Date().toISOString(),
    createdBy: null,
    createdAt: new Date().toISOString(),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class BenchHandler implements VoiceTurnHandler {
  async handleTurn(request: VoiceTurnRequest): Promise<VoiceTurnResult> {
    await sleep(MODEL_MS);
    return {
      turnId: `turn-${request.turnIndex}`,
      reply: "Sure. Could you tell me your monthly electricity bill, roughly?",
      directive: { kind: "continue" },
      usage: { modelCalls: 1 },
      degraded: false,
    };
  }
  async recordDelivery() {}
  async close() {}
}

/** Discards audio; the provider-side playout is not what we are measuring. */
const sink = (): VoiceOutput => ({
  format: { encoding: "mulaw", sampleRate: 8000, channels: 1 },
  supportsMarks: false,
  sendAudio: () => {},
  clear: () => {},
  mark: () => {},
});

function speechFrame(amplitude: number): Uint8Array {
  const samples = 160;
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i++) {
    view.setInt16(i * 2, Math.round(Math.sin((i / 8000) * 2 * Math.PI * 300) * amplitude * 32767), true);
  }
  return pcm16ToMulaw(pcm);
}

const SPEECH = speechFrame(0.3);
const SILENCE = speechFrame(0);

async function main(): Promise<void> {
  const store = new InMemoryCallStore();
  const telephony = new FakeTelephonyProvider("bench-secret");
  const stt = new FakeSttProvider();
  const tts = new FakeTtsProvider({ msPerChar: 12, chunkMs: 60, firstChunkDelayMs: TTS_FIRST_BYTE_MS });
  const built = buildSessionConfig(version().config);
  if (!built.ok) throw new Error(`bench config invalid: ${built.missing.join(", ")}`);

  store.addRoute("fake", "+914000000001", {
    phoneNumberId: "pn",
    business: BUSINESS,
    agentId: "bench-agent",
    agentStatus: "active",
    version: version(),
    handoffNumber: null,
  });

  const gateway = new VoiceGateway({
    callStore: store,
    telephony,
    stt,
    tts,
    createTurnHandler: () => new BenchHandler(),
    sessionConfig: () => built.config,
    limits: { maxConcurrentSessions: CALLS + 1 },
  });

  const samples = new Map<string, number[]>();
  const record = (type: string, ms: number) => {
    const bucket = samples.get(type) ?? [];
    bucket.push(ms);
    samples.set(type, bucket);
  };

  for (let call = 0; call < CALLS; call++) {
    const started = await gateway.startSession({
      provider: "fake",
      providerCallId: `BENCH-${call}`,
      from: "+919800000001",
      to: "+914000000001",
      output: sink(),
    });
    if (!started.ok) throw new Error(`bench call rejected: ${started.reason}`);
    const sessionId = started.sessionId;
    // Let the greeting finish before the first caller turn.
    await sleep(1_200);

    for (let turn = 0; turn < TURNS; turn++) {
      for (let i = 0; i < 25; i++) {
        gateway.receiveAudio(sessionId, SPEECH);
        await sleep(2);
      }
      const speechEndedAt = Date.now();
      // The vendor's transcription lag, then the local endpointer's hangover.
      setTimeout(() => stt.current.final("nenu solar panels gurinchi telusukovali"), STT_FINAL_MS);
      for (let i = 0; i < 60; i++) {
        gateway.receiveAudio(sessionId, SILENCE);
        await sleep(2);
      }
      await sleep(MODEL_MS + TTS_FIRST_BYTE_MS + 400);
      record("caller_turn_wall_ms", Date.now() - speechEndedAt);
    }
    await gateway.endSession(sessionId, "caller_hangup");

    const callRow = [...store.calls.values()].find((c) => c.providerCallId === `BENCH-${call}`)!;
    for (const event of store.events.get(callRow.id) ?? []) {
      if (event.latencyMs !== null) record(event.type, event.latencyMs);
    }
  }

  const rows = [...samples.entries()]
    .map(([type, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        stage: type,
        n: sorted.length,
        p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
        p95: sorted[Math.floor((sorted.length - 1) * 0.95)],
        max: sorted[sorted.length - 1],
      };
    })
    .sort((a, b) => a.stage.localeCompare(b.stage));

  console.log(`\nHALO voice latency harness — MOCK PROVIDERS (not a vendor measurement)`);
  console.log(
    `calls=${CALLS} turns=${TURNS} sttFinal=${STT_FINAL_MS}ms model=${MODEL_MS}ms ttsFirstByte=${TTS_FIRST_BYTE_MS}ms ` +
      `node=${process.version}\n`,
  );
  console.table(rows);
  console.log(
    "\nturn_complete = end-of-speech (endpoint) → first synthesized audio byte, the stage HALO owns.\n" +
      "It excludes PSTN transport, real STT/TTS and real model latency.\n",
  );
  console.log(`one 20 ms μ-law frame = ${audioDurationMs(160, "mulaw", 8000)} ms of audio\n`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
