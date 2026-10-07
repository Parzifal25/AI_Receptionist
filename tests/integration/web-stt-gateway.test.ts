import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { handleWebStt, signWebAudio } from "../../services/voice-gateway/web-stt";
import type { StreamingSttProvider } from "@halo/ports/streaming-stt-provider";
const secret = "test-only-web-stt-signing-key-32-characters";
const servers: Server[] = [];
async function listen(server: Server) { servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("address"); return `http://127.0.0.1:${address.port}`; }
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
describe("web audio → gateway → STT provider port (recording provider)", () => {
  it("delivers exact PCM and format to the configured STT provider and returns its transcript", async () => {
    let received: { audio: string; format: unknown; language: string } | undefined;
    const provider: StreamingSttProvider = {
      name: "recording-stt",
      capabilities: () => ({ languages: [], formats: [{ encoding: "pcm16le", sampleRate: 16000, channels: 1 }], interimResults: false, providerEndpointing: false, reportsConfidence: false }),
      open: (options, listener) => {
        const chunks: Uint8Array[] = [];
        return {
          write: chunk => { chunks.push(chunk.slice()); },
          finalize: () => {
            received = { audio: Buffer.concat(chunks).toString("base64"), format: options.format, language: options.language };
            listener({ type: "final", utteranceId: "recording-1", text: "contract transcript", confidence: null, language: options.language });
          },
          close: async () => { listener({ type: "closed" }); },
        };
      },
    };
    const gatewayUrl = await listen(createServer((req, res) => { void handleWebStt(req, res, secret, provider); }));
    const audio = Buffer.alloc(640, 10).toString("base64");
    const body = JSON.stringify({ businessId: "11111111-1111-4111-8111-111111111111", language: "te-IN", audio, timestamp: Date.now() });
    const response = await fetch(gatewayUrl, { method: "POST", headers: { "x-halo-signature": signWebAudio(secret, body) }, body });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ text: "contract transcript", provider: "recording-stt" });
    expect(received).toMatchObject({ audio, format: { encoding: "pcm16le", sampleRate: 16000, channels: 1 }, language: "te-IN" });
  });
  it("rejects unsigned, altered and stale requests, and refuses an unconfigured provider", async () => {
    const url = await listen(createServer((req, res) => { void handleWebStt(req, res, secret); }));
    const body = JSON.stringify({ businessId: "11111111-1111-4111-8111-111111111111", language: "te-IN", audio: "AAAA", timestamp: Date.now() });
    expect((await fetch(url, { method: "POST", body })).status).toBe(403);
    expect((await fetch(url, { method: "POST", body: body + " ", headers: { "x-halo-signature": signWebAudio(secret, body) } })).status).toBe(403);
    const stale = body.replace(/"timestamp":\d+/, '"timestamp":0');
    expect((await fetch(url, { method: "POST", body: stale, headers: { "x-halo-signature": signWebAudio(secret, stale) } })).status).toBe(400);
    expect((await fetch(url, { method: "POST", body, headers: { "x-halo-signature": signWebAudio(secret, body) } })).status).toBe(503);
  });
});
