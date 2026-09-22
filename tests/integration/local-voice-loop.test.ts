import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { defaultAgentConfig } from "@halo/core/domain/agents";
import { FakeSttProvider } from "@halo/providers/voice-fakes/fake-stt-provider";
import { FakeTelephonyProvider } from "@halo/providers/voice-fakes/fake-telephony-provider";
import { FakeTtsProvider } from "@halo/providers/voice-fakes/fake-tts-provider";
import { VoiceGateway } from "@halo/voice/gateway";
import { InMemoryCallStore } from "@halo/voice/in-memory-call-store";
import { buildSessionConfig } from "@halo/voice/session-config";
import { ScriptedTurnHandler, mulawFrame } from "../mocks/voice-harness";
import { makeVersion, TENANT_A_DID } from "../mocks/voice-gateway-harness";
import { BUSINESS_A } from "../mocks/runtime-fakes";
import { loadGatewayConfig } from "../../services/voice-gateway/config";
import { createGatewayServer, type GatewayServer } from "../../services/voice-gateway/server";
import { Resampler, fromMulaw, toMulaw } from "../../scripts/local-call";

/**
 * Phase 4.5 Sprint 1 — the local development client's protocol, against the
 * REAL gateway process over real HTTP and a real WebSocket.
 *
 * `scripts/local-call.ts` is a laptop pretending to be a carrier. If its
 * frame shapes, signing or token handling drift from what the gateway
 * accepts, the loop stops working and nobody finds out until someone tries
 * to demo it. This walks the exact sequence the script walks — signed
 * webhook, stream token, `start`, 20 ms μ-law frames, agent audio back,
 * mark acknowledgement, `stop` — with the microphone and speaker replaced by
 * buffers.
 *
 * It proves the PROTOCOL. It proves nothing about audio devices, and
 * nothing about telephony: there is no PSTN leg here any more than there is
 * in the script itself.
 */

const SECRET = "fake-webhook-secret-value";
const STREAM_SECRET = "stream-token-secret-at-least-32-chars";
const PUBLIC = "wss://gateway.test/media";

const PROMPTS = {
  greeting: "Hello, this is an automated assistant.",
  reprompt: "Are you still there?",
  goodbye: "Goodbye.",
  turnFailure: "Sorry, say that again?",
  transferAnnounce: "Please hold.",
  transferFailed: "Nobody is free.",
};

let server: GatewayServer;
let port: number;
let stt: FakeSttProvider;
let handler: ScriptedTurnHandler;

/** Exactly how the client signs: HMAC over `url \n body`, hex, in a header. */
function sign(url: string, body: string): string {
  return createHmac("sha256", SECRET).update(`${url}\n${body}`).digest("hex");
}

async function webhook(path: string, payload: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify(payload);
  const signedUrl = new URL(path, PUBLIC.replace("wss://", "https://")).toString();
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fake-signature": sign(signedUrl, body) },
    body,
  });
}

beforeEach(async () => {
  const store = new InMemoryCallStore();
  stt = new FakeSttProvider();
  handler = new ScriptedTurnHandler().then({
    reply: "Cheppandi, ela help cheyyanu?",
    turnId: "t1",
    timings: { contextReadyMs: 35, firstTokenMs: 180, modelMs: 420, validationMs: 8 },
  });
  const version = makeVersion(BUSINESS_A.id, "agent-a", "av-a-3");
  version.config = defaultAgentConfig();
  version.config.language.primary = "te-IN";
  version.config.voice.prompts = PROMPTS;
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
  server = createGatewayServer({
    config: loadGatewayConfig({
      VOICE_GATEWAY_PUBLIC_WS_URL: PUBLIC,
      VOICE_STREAM_TOKEN_SECRET: STREAM_SECRET,
      TELEPHONY_PROVIDER: "fake",
      VOICE_FAKE_WEBHOOK_SECRET: SECRET,
    }),
    gateway,
    telephony,
  });
  port = await server.listen(0);
});

afterEach(async () => {
  await server.close();
});

describe("local voice loop — the dev client's protocol against the real gateway", () => {
  it("converts microphone audio to the media contract, not the other way round", () => {
    // 48 kHz mono PCM16, one 20 ms block: what a laptop mic actually hands over.
    const captured = Buffer.alloc(48_000 * 0.02 * 2);
    for (let i = 0; i < captured.length / 2; i++) {
      captured.writeInt16LE(Math.round(Math.sin((i / 48_000) * 2 * Math.PI * 440) * 12_000), i * 2);
    }
    const samples = new Resampler(48_000).push(captured);
    // 20 ms at 8 kHz is 160 samples — one frame on the wire, every time.
    expect(samples.length).toBe(160);
    const mulaw = toMulaw(samples);
    expect(mulaw.length).toBe(160);
    // And it survives the round trip well enough to still be that tone.
    const back = fromMulaw(mulaw);
    expect(back.length).toBe(320);
    let energy = 0;
    for (let i = 0; i < back.length; i += 2) energy += (back.readInt16LE(i) / 32768) ** 2;
    expect(Math.sqrt(energy / (back.length / 2))).toBeGreaterThan(0.1);
  });

  it("rejects a capture rate below the wire rate rather than upsampling silently", () => {
    expect(() => new Resampler(4_000)).toThrow(/below the 8 kHz wire rate/);
  });

  it("runs a whole call: signed webhook, media socket, caller audio, agent audio, hang-up", async () => {
    const providerCallId = `LOCAL-${randomUUID().slice(0, 8)}`;

    // 1. Place the call exactly as the client does.
    const inbound = await webhook("/telephony/fake/inbound", {
      type: "inbound",
      callId: providerCallId,
      from: "+919800000001",
      to: TENANT_A_DID,
    });
    expect(inbound.status).toBe(200);
    const answer = (await inbound.json()) as { action: string; parameters: Record<string, string> };
    expect(answer.action).toBe("connect_stream");
    expect(answer.parameters.token).toBeTruthy();

    // 2. Open the media socket to the LOCAL address while presenting the
    //    token minted for the public one: the token is the security
    //    boundary, not the hostname.
    const socket = new WebSocket(`ws://127.0.0.1:${port}/media`);
    const inboundFrames: Array<{ event?: string; payload?: string; name?: string }> = [];
    socket.on("message", (data: Buffer) => inboundFrames.push(JSON.parse(data.toString())));
    await new Promise((resolve) => socket.on("open", resolve));
    socket.send(JSON.stringify({ event: "start", callId: providerCallId, streamId: "LOCALSTREAM-1", parameters: answer.parameters }));

    // 3. The greeting comes back as base64 μ-law the client can decode.
    await waitFor(() => inboundFrames.some((f) => f.event === "media"));
    const greeting = inboundFrames.find((f) => f.event === "media")!;
    const decoded = fromMulaw(Buffer.from(greeting.payload!, "base64"));
    expect(decoded.length % 2).toBe(0);
    expect(decoded.length).toBeGreaterThan(0);

    // Acknowledge playback the way the client does, so the turn settles.
    for (const frame of inboundFrames.filter((f) => f.event === "mark")) {
      socket.send(JSON.stringify({ event: "mark", name: frame.name }));
    }

    // 4. Speak: 20 ms μ-law frames, exactly what the resampler produces.
    for (let i = 0; i < 25; i++) {
      socket.send(JSON.stringify({ event: "media", payload: Buffer.from(mulawFrame(0.3)).toString("base64") }));
      await sleep(2);
    }
    stt.current.final("Solar panel gurinchi cheppandi");
    for (let i = 0; i < 40; i++) {
      socket.send(JSON.stringify({ event: "media", payload: Buffer.from(mulawFrame(0)).toString("base64") }));
      await sleep(2);
    }

    // 5. HALO ran a real turn over this media path.
    await waitFor(() => handler.requests.length > 0, 4_000);
    expect(handler.requests[0].utterance).toBe("Solar panel gurinchi cheppandi");

    await waitFor(() => inboundFrames.filter((f) => f.event === "media").length > 1, 4_000);
    for (const frame of inboundFrames.filter((f) => f.event === "mark")) {
      socket.send(JSON.stringify({ event: "mark", name: frame.name }));
    }

    // 6. Hang up as a carrier does, so the call finalizes instead of ageing out.
    socket.send(JSON.stringify({ event: "stop" }));
    const status = await webhook("/telephony/fake/status", { type: "status", callId: providerCallId, status: "completed" });
    expect(status.status).toBe(204);
    socket.close();
  });

  it("refuses a media socket whose token was not minted for that call", async () => {
    const inbound = await webhook("/telephony/fake/inbound", {
      type: "inbound",
      callId: "LOCAL-REAL",
      from: "+919800000001",
      to: TENANT_A_DID,
    });
    const answer = (await inbound.json()) as { parameters: Record<string, string> };

    const socket = new WebSocket(`ws://127.0.0.1:${port}/media`);
    await new Promise((resolve) => socket.on("open", resolve));
    const closed = new Promise<number>((resolve) => socket.on("close", (code: number) => resolve(code)));
    // Same valid token, a different call id: a dev client must not be able
    // to attach itself to somebody else's live call.
    socket.send(JSON.stringify({ event: "start", callId: "LOCAL-OTHER", streamId: "s", parameters: answer.parameters }));
    expect(await closed).toBe(1008);
  });

  it("refuses an unsigned webhook, so the loop cannot be driven without the secret", async () => {
    const body = JSON.stringify({ type: "inbound", callId: "LOCAL-X", from: "+919800000001", to: TENANT_A_DID });
    const response = await fetch(`http://127.0.0.1:${port}/telephony/fake/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(403);
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("timed out waiting for the gateway");
}
