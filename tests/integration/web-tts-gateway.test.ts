import { createServer, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { handleWebTts } from "../../services/voice-gateway/web-tts";
import { signWebAudio, signWebTts } from "@halo/voice/web-audio-auth";
import type { StreamingTtsProvider } from "@halo/ports/streaming-tts-provider";
const secret = "test-only-stream-secret-at-least-32-chars";
const servers: Server[] = [];
const format = { encoding: "pcm16le", sampleRate: 16000, channels: 1 } as const;
async function listen(provider?: StreamingTtsProvider) {
 const server = createServer((req, res) => { void handleWebTts(req, res, secret, 16000, provider); }); servers.push(server);
 await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
 const address = server.address(); if (!address || typeof address === "string") throw new Error("address"); return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
function body(timestamp = Date.now()) { return JSON.stringify({ businessId: "11111111-1111-4111-8111-111111111111", language: "te", text: "HALO reply", timestamp }); }
it("passes configured PCM format through the provider and returns exact audio", async () => {
 const synthesize = vi.fn(async function* () { yield new Uint8Array([1, 2, 3, 4]); });
 const url = await listen({ name: "contract-tts", capabilities: () => ({ formats: [format], languages: ["te-IN"], voices: [] }), synthesize });
 const payload = body(); const response = await fetch(url, { method: "POST", body: payload, headers: { "x-halo-signature": signWebTts(secret, payload) } });
 expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ audio: "AQIDBA==", format });
 expect(synthesize).toHaveBeenCalledWith({ text: "HALO reply", language: "te-IN", format }, expect.any(AbortSignal));
});
it("rejects unsigned, tampered, cross-purpose and stale signatures", async () => {
 const url = await listen(); const payload = body();
 for (const signature of ["", signWebAudio(secret, payload), signWebTts(secret, payload + " "), "é".repeat(64)]) {
  expect((await fetch(url, { method: "POST", body: payload, headers: { "x-halo-signature": signature } })).status).toBe(403);
 }
 const stale = body(0); expect((await fetch(url, { method: "POST", body: stale, headers: { "x-halo-signature": signWebTts(secret, stale) } })).status).toBe(400);
 expect((await fetch(url, { method: "POST", body: payload, headers: { "x-halo-signature": signWebTts(secret, payload) } })).status).toBe(503);
});
it("never reports empty or failed synthesis as playable audio", async () => {
 const url = await listen({ name: "contract-tts", capabilities: () => ({ formats: [format], languages: [], voices: [] }), async *synthesize() { throw new Error("secret-provider-detail"); yield new Uint8Array(); } });
 const payload = body(); const response = await fetch(url, { method: "POST", body: payload, headers: { "x-halo-signature": signWebTts(secret, payload) } });
 expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: "tts_provider" });
});
