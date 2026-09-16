import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { defaultAgentConfig } from "@halo/core/domain/agents";
import { FakeSttProvider } from "@halo/providers/voice-fakes/fake-stt-provider";
import { FakeTelephonyProvider, signFakeWebhook } from "@halo/providers/voice-fakes/fake-telephony-provider";
import { FakeTtsProvider } from "@halo/providers/voice-fakes/fake-tts-provider";
import { VoiceGateway } from "@halo/voice/gateway";
import { InMemoryCallStore } from "@halo/voice/in-memory-call-store";
import { buildSessionConfig } from "@halo/voice/session-config";
import { mulawFrame } from "../mocks/voice-harness";
import { ScriptedTurnHandler } from "../mocks/voice-harness";
import { makeVersion, TENANT_A_DID } from "../mocks/voice-gateway-harness";
import { BUSINESS_A } from "../mocks/runtime-fakes";
import { loadGatewayConfig } from "../../services/voice-gateway/config";
import { createGatewayServer, type GatewayServer } from "../../services/voice-gateway/server";

/**
 * Phase 3 — the voice gateway PROCESS over a real local WebSocket: webhook
 * signature verification, stream-token authentication of the media socket,
 * bidirectional audio, and graceful shutdown. Deterministic fakes below the
 * ports; real HTTP and real WS above them.
 */

const SECRET = "fake-webhook-secret-value";
const STREAM_SECRET = "stream-token-secret-at-least-32-chars";

const PROMPTS = {
  greeting: "Hello, this is an automated assistant.",
  reprompt: "Are you still there?",
  goodbye: "Goodbye.",
  turnFailure: "Sorry, say that again?",
  transferAnnounce: "Please hold.",
  transferFailed: "Nobody is free.",
};

function voiceAgentConfig() {
  const config = defaultAgentConfig();
  config.language.primary = "te-IN";
  config.voice.prompts = PROMPTS;
  return config;
}

let server: GatewayServer;
let port: number;
let store: InMemoryCallStore;
let stt: FakeSttProvider;
let handler: ScriptedTurnHandler;
const PUBLIC = "wss://gateway.test/media";

beforeEach(async () => {
  store = new InMemoryCallStore();
  stt = new FakeSttProvider();
  handler = new ScriptedTurnHandler().then({ reply: "Cheppandi, ela help cheyyanu?", turnId: "t1" });
  const version = makeVersion(BUSINESS_A.id, "agent-a", "av-a-3");
  version.config = voiceAgentConfig();
  store.addRoute("fake", TENANT_A_DID, {
    phoneNumberId: "pn-a",
    business: BUSINESS_A,
    agentId: "agent-a",
    agentStatus: "active",
    version,
    handoffNumber: null,
  });
  const telephony = new FakeTelephonyProvider(SECRET);
  const gateway = new VoiceGateway({
    callStore: store,
    telephony,
    stt,
    tts: new FakeTtsProvider({ msPerChar: 2, chunkMs: 40 }),
    createTurnHandler: () => handler,
    sessionConfig: (ctx) => {
      const built = buildSessionConfig(ctx.route.version.config);
      if (!built.ok) throw new Error(`missing prompts: ${built.missing.join(",")}`);
      return built.config;
    },
  });
  const config = loadGatewayConfig({
    VOICE_GATEWAY_PUBLIC_WS_URL: PUBLIC,
    VOICE_STREAM_TOKEN_SECRET: STREAM_SECRET,
    TELEPHONY_PROVIDER: "fake",
    VOICE_FAKE_WEBHOOK_SECRET: SECRET,
  });
  server = createGatewayServer({
    config,
    gateway,
    telephony,
    canAnswer: async ({ to }) => (await store.resolveInboundRoute("fake", to)) !== null,
  });
  port = await server.listen(0);
});

afterEach(async () => {
  await server.close();
});

function inbound(body: Record<string, unknown>, opts: { sign?: boolean; signWith?: string } = {}) {
  const rawBody = JSON.stringify(body);
  const url = `https://gateway.test/telephony/fake/inbound`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.sign !== false) headers["x-fake-signature"] = signFakeWebhook(opts.signWith ?? SECRET, url, rawBody);
  return fetch(`http://127.0.0.1:${port}/telephony/fake/inbound`, { method: "POST", headers, body: rawBody });
}

async function openMedia(params: Record<string, string>, callId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/media`);
  const frames: Array<Record<string, unknown>> = [];
  const closes: Array<{ code: number }> = [];
  ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
  ws.on("close", (code) => closes.push({ code }));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ event: "start", callId, streamId: "S1", parameters: params }));
  return { ws, frames, closes };
}

const waitFor = async (predicate: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
};

describe("voice gateway service", () => {
  it("answers a signed inbound webhook with stream instructions and a bound token", async () => {
    const response = await inbound({ type: "inbound", callId: "CA-1", from: "+919800000001", to: TENANT_A_DID });
    expect(response.status).toBe(200);
    const answer = JSON.parse(await response.text());
    expect(answer).toMatchObject({ action: "connect_stream", url: PUBLIC });
    expect(answer.parameters.token).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(answer.parameters).toMatchObject({ callId: "CA-1", from: "+919800000001", to: TENANT_A_DID });
  });

  it("rejects unsigned and wrongly-signed webhooks, and fails closed with no secret", async () => {
    expect((await inbound({ type: "inbound", callId: "CA-2", to: TENANT_A_DID }, { sign: false })).status).toBe(403);
    expect((await inbound({ type: "inbound", callId: "CA-2", to: TENANT_A_DID }, { signWith: "wrong" })).status).toBe(403);
  });

  it("declines a call to a number that routes nowhere", async () => {
    const response = await inbound({ type: "inbound", callId: "CA-3", from: "+91", to: "+914000009999" });
    expect(JSON.parse(await response.text())).toMatchObject({ action: "reject" });
    expect(store.calls.size).toBe(0);
  });

  it("runs a full call over the media socket", async () => {
    const answer = JSON.parse(await (await inbound({ type: "inbound", callId: "CA-4", from: "+919800000001", to: TENANT_A_DID })).text());
    const { ws, frames } = await openMedia(answer.parameters, "CA-4");

    // Greeting audio comes back as media frames.
    expect(await waitFor(() => frames.some((f) => f.event === "media"))).toBe(true);
    await waitFor(() => frames.some((f) => f.event === "mark"));
    for (const mark of frames.filter((f) => f.event === "mark")) {
      ws.send(JSON.stringify({ event: "mark", name: mark.name }));
    }

    // Caller speaks; the scripted STT produces the transcript.
    const speech = Buffer.from(mulawFrame(0.3)).toString("base64");
    for (let i = 0; i < 20; i++) ws.send(JSON.stringify({ event: "media", payload: speech }));
    await waitFor(() => stt.streams.length > 0 && stt.current.bytesWritten > 0);
    stt.current.final("Naaku solar panels kavali");
    const silence = Buffer.from(mulawFrame(0)).toString("base64");
    for (let i = 0; i < 40; i++) ws.send(JSON.stringify({ event: "media", payload: silence }));

    expect(await waitFor(() => handler.requests.length === 1, 5_000)).toBe(true);
    expect(handler.requests[0].utterance).toBe("Naaku solar panels kavali");

    ws.send(JSON.stringify({ event: "stop" }));
    expect(await waitFor(() => [...store.calls.values()][0]?.state === "completed", 5_000)).toBe(true);
    const call = [...store.calls.values()][0];
    expect(call.finalization?.hangupCause).toBe("caller_hangup");
    expect(store.transcripts.get(call.id)!.some((t) => t.text === "Naaku solar panels kavali")).toBe(true);
    ws.close();
  });

  it("refuses a media socket whose token is missing, tampered or for another number", async () => {
    const answer = JSON.parse(await (await inbound({ type: "inbound", callId: "CA-5", from: "+919800000001", to: TENANT_A_DID })).text());
    const none = await openMedia({ callId: "CA-5" }, "CA-5");
    expect(await waitFor(() => none.closes.length > 0)).toBe(true);
    expect(none.closes[0].code).toBe(1008);

    // Same token, but claiming a different dialled number.
    const swapped = await openMedia({ ...answer.parameters, to: "+914000009999" }, "CA-5");
    expect(await waitFor(() => swapped.closes.length > 0)).toBe(true);
    expect(swapped.closes[0].code).toBe(1008);

    // Same token, different call id.
    const otherCall = await openMedia(answer.parameters, "CA-OTHER");
    expect(await waitFor(() => otherCall.closes.length > 0)).toBe(true);
    expect(store.calls.size).toBe(0);
  });

  it("reports health and drains on shutdown", async () => {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(health).toMatchObject({ status: "ok", sessions: 0, provider: "fake" });
    const answer = JSON.parse(await (await inbound({ type: "inbound", callId: "CA-6", from: "+919800000001", to: TENANT_A_DID })).text());
    const { closes } = await openMedia(answer.parameters, "CA-6");
    expect(await waitFor(() => store.calls.size === 1)).toBe(true);
    await server.close();
    expect(await waitFor(() => closes.length > 0)).toBe(true);
    const call = [...store.calls.values()][0];
    expect(call.finalization?.hangupCause).toBe("gateway_shutdown");
  });
});
