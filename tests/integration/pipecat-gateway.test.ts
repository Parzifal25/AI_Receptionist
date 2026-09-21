import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { defaultAgentConfig } from "@halo/core/domain/agents";
import { FakeSttProvider } from "@halo/providers/voice-fakes/fake-stt-provider";
import { FakeTelephonyProvider, signFakeWebhook } from "@halo/providers/voice-fakes/fake-telephony-provider";
import { FakeTtsProvider } from "@halo/providers/voice-fakes/fake-tts-provider";
import { VoiceGateway } from "@halo/voice/gateway";
import { InMemoryCallStore } from "@halo/voice/in-memory-call-store";
import { PipecatBridge } from "@halo/voice/pipecat/bridge";
import { PIPECAT_PROTOCOL_VERSION } from "@halo/voice/pipecat/protocol";
import { buildSessionConfig } from "@halo/voice/session-config";
import { ScriptedTurnHandler } from "../mocks/voice-harness";
import { makeVersion, TENANT_A_DID, TENANT_B_DID } from "../mocks/voice-gateway-harness";
import { BUSINESS_A, BUSINESS_B } from "../mocks/runtime-fakes";
import { loadGatewayConfig } from "../../services/voice-gateway/config";
import { createGatewayServer, type GatewayServer } from "../../services/voice-gateway/server";

/**
 * Phase 4 — the Pipecat control plane over a real local WebSocket.
 *
 * What this proves, end to end and without faking the transport:
 *   - a worker is authenticated by the same stream token the media socket
 *     uses, and cannot open a session for a number it was not handed;
 *   - tenant, agent and agent version are resolved from the dialled number
 *     server-side and pushed to the worker, never read back from it;
 *   - a full call runs through the UNCHANGED gateway: call row, technical
 *     state machine, transcript rows, outcome;
 *   - no audio ever crosses the control socket.
 */

const SECRET = "fake-webhook-secret-value";
const STREAM_SECRET = "stream-token-secret-at-least-32-chars";
const PUBLIC = "wss://gateway.test/media";
const PIPECAT_MEDIA = "wss://pipecat.test/ws";

const PROMPTS = {
  greeting: "Namaskaram, idi automated assistant.",
  reprompt: "Meeru vinipistunnara?",
  goodbye: "Dhanyavadalu.",
  turnFailure: "Malli cheppandi.",
  transferAnnounce: "Konchem aagandi.",
  transferFailed: "Ippudu evaru available leru.",
};

function voiceAgentConfig() {
  const config = defaultAgentConfig();
  config.language.primary = "te-IN";
  config.language.fallbacks = ["en-IN"];
  config.voice.prompts = PROMPTS;
  config.voice.phraseHints = ["solar", "kilowatt"];
  return config;
}

let server: GatewayServer;
let port: number;
let store: InMemoryCallStore;
let handler: ScriptedTurnHandler;
let bridge: PipecatBridge;

beforeEach(async () => {
  store = new InMemoryCallStore();
  handler = new ScriptedTurnHandler().then({ reply: "Mee current bill entha?", turnId: "t1" });
  for (const [did, business, agentId, versionId] of [
    [TENANT_A_DID, BUSINESS_A, "agent-a", "av-a-3"],
    [TENANT_B_DID, BUSINESS_B, "agent-b", "av-b-3"],
  ] as const) {
    const version = makeVersion(business.id, agentId, versionId);
    version.config = voiceAgentConfig();
    store.addRoute("fake", did, {
      phoneNumberId: `pn-${agentId}`,
      business,
      agentId,
      agentStatus: "active",
      version,
      handoffNumber: null,
    });
  }
  const telephony = new FakeTelephonyProvider(SECRET);
  bridge = new PipecatBridge();
  const gateway = new VoiceGateway({
    callStore: store,
    telephony,
    // Never opened on this path: the media loop is Pipecat's.
    stt: new FakeSttProvider(),
    tts: new FakeTtsProvider(),
    createMediaSession: bridge.createMediaSession,
    createTurnHandler: () => handler,
    sessionConfig: (ctx) => {
      const built = buildSessionConfig(ctx.route.version.config);
      if (!built.ok) throw new Error(`missing prompts: ${built.missing.join(",")}`);
      return built.config;
    },
  });
  bridge.bindGateway(gateway);
  const config = loadGatewayConfig({
    VOICE_GATEWAY_PUBLIC_WS_URL: PUBLIC,
    VOICE_STREAM_TOKEN_SECRET: STREAM_SECRET,
    TELEPHONY_PROVIDER: "fake",
    VOICE_FAKE_WEBHOOK_SECRET: SECRET,
    VOICE_MEDIA_ENGINE: "pipecat",
    VOICE_PIPECAT_MEDIA_WS_URL: PIPECAT_MEDIA,
  });
  server = createGatewayServer({
    config,
    gateway,
    telephony,
    pipecat: bridge,
    canAnswer: async ({ to }) => (await store.resolveInboundRoute("fake", to)) !== null,
  });
  port = await server.listen(0);
});

afterEach(async () => {
  await server.close();
});

function inbound(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  const url = "https://gateway.test/telephony/fake/inbound";
  return fetch(`http://127.0.0.1:${port}/telephony/fake/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fake-signature": signFakeWebhook(SECRET, url, rawBody) },
    body: rawBody,
  });
}

async function answerFor(callId: string, to = TENANT_A_DID) {
  const response = await inbound({ type: "inbound", callId, from: "+919800000001", to });
  return JSON.parse(await response.text());
}

interface Worker {
  ws: WebSocket;
  commands: Array<Record<string, unknown>>;
  closes: Array<{ code: number }>;
  send(frame: Record<string, unknown>): void;
}

async function connectWorker(hello: Record<string, unknown>): Promise<Worker> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/pipecat/control`);
  const commands: Array<Record<string, unknown>> = [];
  const closes: Array<{ code: number }> = [];
  ws.on("message", (data) => commands.push(JSON.parse(data.toString())));
  ws.on("close", (code) => closes.push({ code }));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify(hello));
  return { ws, commands, closes, send: (frame) => ws.send(JSON.stringify(frame)) };
}

const waitFor = async (predicate: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
};

const helloFor = (answer: { parameters: Record<string, string> }, callId: string) => ({
  type: "hello",
  protocol: PIPECAT_PROTOCOL_VERSION,
  providerCallId: callId,
  from: answer.parameters.from,
  to: answer.parameters.to,
  token: answer.parameters.token,
  worker: "pipecat-test",
});

describe("pipecat control plane", () => {
  it("points the provider at the worker and tells it where HALO's control plane is", async () => {
    const answer = await answerFor("PC-1");
    expect(answer).toMatchObject({ action: "connect_stream", url: PIPECAT_MEDIA });
    expect(answer.parameters.haloControlUrl).toBe("wss://gateway.test/pipecat/control");
    expect(answer.parameters.token).toMatch(/^\d+\.[0-9a-f]{64}$/);
  });

  it("resolves the tenant server-side and hands the worker its identity and media config", async () => {
    const answer = await answerFor("PC-2");
    const worker = await connectWorker(helloFor(answer, "PC-2"));
    expect(await waitFor(() => worker.commands.some((c) => c.type === "ready"))).toBe(true);

    const ready = worker.commands.find((c) => c.type === "ready") as {
      session: Record<string, string>;
      voice: Record<string, unknown>;
    };
    expect(ready.session).toMatchObject({
      tenantId: BUSINESS_A.id,
      agentId: "agent-a",
      agentVersionId: "av-a-3",
      conversationId: expect.any(String),
    });
    expect(ready.session.callId).toBe(ready.session.sessionId);
    expect(ready.voice).toMatchObject({ language: "te-IN", alternativeLanguages: ["en-IN"], phraseHints: ["solar", "kilowatt"] });
    // Spoken content is never part of the worker's configuration.
    expect(JSON.stringify(ready.voice)).not.toContain(PROMPTS.greeting);
    worker.ws.close();
  });

  it("runs a full call: greeting, caller turn, reply, hangup, persisted transcript and outcome", async () => {
    const answer = await answerFor("PC-3");
    const worker = await connectWorker(helloFor(answer, "PC-3"));
    expect(await waitFor(() => worker.commands.some((c) => c.type === "speak"))).toBe(true);

    const greeting = worker.commands.find((c) => c.type === "speak") as { playbackId: string; chunks: string[]; kind: string };
    expect(greeting.kind).toBe("policy");
    expect(greeting.chunks.join(" ")).toBe(PROMPTS.greeting);
    worker.send({ type: "playback", playbackId: greeting.playbackId, phase: "first_audio" });
    worker.send({ type: "playback", playbackId: greeting.playbackId, phase: "chunk_played", chunkIndex: 0 });
    worker.send({ type: "playback", playbackId: greeting.playbackId, phase: "stopped", reason: "completed", audioMs: 1_200 });

    worker.send({ type: "speech_started" });
    worker.send({
      type: "transcript",
      final: true,
      text: "Naaku solar panels kavali",
      utteranceId: "u1",
      language: "te-IN",
      confidence: 0.82,
    });
    worker.send({ type: "speech_stopped" });

    expect(await waitFor(() => handler.requests.length === 1, 5_000)).toBe(true);
    expect(handler.requests[0].utterance).toBe("Naaku solar panels kavali");
    expect(handler.requests[0].language).toBe("te-IN");
    expect(handler.requests[0].sttConfidence).toBe(0.82);

    expect(await waitFor(() => worker.commands.filter((c) => c.type === "speak").length === 2)).toBe(true);
    const reply = worker.commands.filter((c) => c.type === "speak")[1] as { playbackId: string; kind: string; turnId: string; chunks: string[] };
    expect(reply.kind).toBe("reply");
    expect(reply.turnId).toBe("t1");
    worker.send({ type: "playback", playbackId: reply.playbackId, phase: "first_audio" });
    worker.send({ type: "playback", playbackId: reply.playbackId, phase: "chunk_played", chunkIndex: 0 });
    worker.send({ type: "playback", playbackId: reply.playbackId, phase: "stopped", reason: "completed", audioMs: 900 });
    expect(await waitFor(() => handler.deliveries.length === 1)).toBe(true);
    expect(handler.deliveries[0]).toMatchObject({ turnId: "t1", status: "complete" });

    worker.send({ type: "usage", inboundAudioMs: 8_000, outboundAudioMs: 2_100, ttsCharacters: 64 });
    worker.send({ type: "bye", reason: "caller_hangup" });

    expect(await waitFor(() => [...store.calls.values()][0]?.state === "completed", 5_000)).toBe(true);
    const call = [...store.calls.values()][0];
    expect(call.businessId).toBe(BUSINESS_A.id);
    expect(call.finalization?.hangupCause).toBe("caller_hangup");
    expect(call.finalization?.usage.inboundAudioSeconds).toBe(8);
    expect(call.finalization?.usage.ttsCharacters).toBe(64);
    expect(store.transcripts.get(call.id)!.some((t) => t.text === "Naaku solar panels kavali")).toBe(true);
    expect(store.outcomes.get(call.id)).toBeDefined();
    worker.ws.close();
  });

  it("records only what the caller heard when the worker reports an interruption", async () => {
    handler = new ScriptedTurnHandler().then({ reply: "First part here. Second part here. Third part here.", turnId: "t9" });
    const answer = await answerFor("PC-4");
    const worker = await connectWorker(helloFor(answer, "PC-4"));
    expect(await waitFor(() => worker.commands.some((c) => c.type === "speak"))).toBe(true);
    const greeting = worker.commands.find((c) => c.type === "speak") as { playbackId: string };
    worker.send({ type: "playback", playbackId: greeting.playbackId, phase: "stopped", reason: "completed" });

    worker.send({ type: "speech_started" });
    worker.send({ type: "transcript", final: true, text: "cheppandi", utteranceId: "u1", language: "te-IN", confidence: 0.9 });
    worker.send({ type: "speech_stopped" });
    expect(await waitFor(() => worker.commands.filter((c) => c.type === "speak").length === 2)).toBe(true);
    const reply = worker.commands.filter((c) => c.type === "speak")[1] as { playbackId: string; chunks: string[] };
    expect(reply.chunks).toHaveLength(3);

    worker.send({ type: "playback", playbackId: reply.playbackId, phase: "first_audio" });
    worker.send({ type: "playback", playbackId: reply.playbackId, phase: "chunk_played", chunkIndex: 0 });
    // Caller talks over the second sentence; the worker cut it locally.
    worker.send({ type: "speech_started" });
    worker.send({ type: "playback", playbackId: reply.playbackId, phase: "stopped", reason: "interrupted" });

    expect(await waitFor(() => handler.deliveries.length === 1)).toBe(true);
    expect(handler.deliveries[0].status).toBe("interrupted");
    expect(handler.deliveries[0].deliveredText).toBe("First part here.");
    worker.ws.close();
  });

  it("refuses a worker whose token is missing, tampered, or for another tenant's number", async () => {
    const answer = await answerFor("PC-5");

    const noToken = await connectWorker({ ...helloFor(answer, "PC-5"), token: "" });
    expect(await waitFor(() => noToken.closes.length > 0)).toBe(true);
    expect(noToken.closes[0].code).toBe(1008);

    // A worker trying to answer for a DIFFERENT tenant with a valid token.
    const swapped = await connectWorker({ ...helloFor(answer, "PC-5"), to: TENANT_B_DID });
    expect(await waitFor(() => swapped.closes.length > 0)).toBe(true);
    expect(swapped.closes[0].code).toBe(1008);

    // A worker claiming a different call id.
    const otherCall = await connectWorker({ ...helloFor(answer, "PC-5"), providerCallId: "PC-OTHER" });
    expect(await waitFor(() => otherCall.closes.length > 0)).toBe(true);
    expect(store.calls.size).toBe(0);
  });

  it("refuses a worker built against an incompatible protocol version", async () => {
    const answer = await answerFor("PC-6");
    const worker = await connectWorker({ ...helloFor(answer, "PC-6"), protocol: "2.0" });
    expect(await waitFor(() => worker.closes.length > 0)).toBe(true);
    expect(worker.closes[0].code).toBe(1008);
    expect(store.calls.size).toBe(0);
  });

  it("ignores malformed and binary frames instead of acting on them", async () => {
    const answer = await answerFor("PC-7");
    const worker = await connectWorker(helloFor(answer, "PC-7"));
    expect(await waitFor(() => worker.commands.some((c) => c.type === "ready"))).toBe(true);

    worker.ws.send("not json at all");
    worker.ws.send(JSON.stringify({ type: "transcript" })); // missing required fields
    worker.ws.send(JSON.stringify({ type: "wat" }));
    worker.ws.send(Buffer.from([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 50));

    expect(handler.requests).toHaveLength(0);
    expect(worker.closes).toHaveLength(0);
    worker.ws.close();
  });

  it("finalizes the call when the control socket drops without a bye", async () => {
    const answer = await answerFor("PC-8");
    const worker = await connectWorker(helloFor(answer, "PC-8"));
    expect(await waitFor(() => store.calls.size === 1)).toBe(true);
    worker.ws.close();
    expect(await waitFor(() => [...store.calls.values()][0]?.finalization !== undefined, 5_000)).toBe(true);
    expect([...store.calls.values()][0].finalization?.hangupCause).toBe("media_disconnected");
  });
});
