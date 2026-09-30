import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TwilioMediaStreamProvider } from "@halo/providers/telephony/twilio-media-stream-provider";
import { createGatewayServer, type GatewayServer } from "../../services/voice-gateway/server";
import { loadGatewayConfig } from "../../services/voice-gateway/config";
import { buildGateway } from "../mocks/voice-gateway-harness";
const token = "test-auth-token";
let server: GatewayServer | undefined;
afterEach(async () => { await server?.close(); });
async function setup(authorized = true) {
  const g = buildGateway();
  const bindOutbound = vi.fn(async () => authorized), canAnswerOutbound = vi.fn(async () => authorized);
  server = createGatewayServer({ gateway: g.gateway, telephony: new TwilioMediaStreamProvider({ accountSid: "account", authToken: token }),
    config: loadGatewayConfig({ TELEPHONY_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "account", TWILIO_AUTH_TOKEN: token,
      VOICE_STT_PROVIDER: "fake", VOICE_TTS_PROVIDER: "fake", VOICE_GATEWAY_PUBLIC_WS_URL: "wss://gateway.test/media",
      VOICE_STREAM_TOKEN_SECRET: "stream-secret-at-least-thirty-two-characters" }), bindOutbound, canAnswerOutbound });
  return { port: await server.listen(0), bindOutbound, canAnswerOutbound };
}
function signedBody(path: string, valid = true) {
  const body = new URLSearchParams({ CallSid: "CA-outbound", Direction: "outbound-api", CallStatus: "in-progress", From: "+12025550100", To: "+12025550101" });
  let data = `https://gateway.test${path}`;
  for (const key of [...body.keys()].sort()) data += key + body.get(key);
  return { method: "POST", body, headers: { "x-twilio-signature": valid ? createHmac("sha1", token).update(data).digest("base64") : "invalid" } };
}
describe("outbound answer webhook", () => {
  it("binds a signature-verified attempt before minting stream authorization", async () => {
    const g = await setup();
    const path = "/telephony/twilio/outbound?attempt=contact%3A1";
    const result = await fetch(`http://127.0.0.1:${g.port}${path}`, signedBody(path));
    expect(result.status).toBe(200);
    expect(await result.text()).toContain("<Stream");
    expect(g.bindOutbound).toHaveBeenCalledWith({ attemptKey: "contact:1", providerCallId: "CA-outbound", from: "+12025550100", to: "+12025550101" });
    expect(g.canAnswerOutbound).toHaveBeenCalledTimes(1);
  });
  it("never binds unsigned carrier input", async () => {
    const g = await setup();
    const path = "/telephony/twilio/outbound?attempt=contact%3A1";
    expect((await fetch(`http://127.0.0.1:${g.port}${path}`, signedBody(path, false))).status).toBe(403);
    expect(g.bindOutbound).not.toHaveBeenCalled();
  });
  it("refuses an unknown or stale claimed attempt", async () => {
    const g = await setup(false);
    const path = "/telephony/twilio/outbound?attempt=contact%3A1";
    expect((await fetch(`http://127.0.0.1:${g.port}${path}`, signedBody(path))).status).toBe(403);
    expect(g.canAnswerOutbound).not.toHaveBeenCalled();
  });
  it("never mints a stream token without durable attempt correlation", async () => {
    const g = await setup();
    const path = "/telephony/twilio/outbound";
    const result = await fetch(`http://127.0.0.1:${g.port}${path}`, signedBody(path));
    expect(await result.text()).not.toContain("<Stream");
    expect(g.bindOutbound).not.toHaveBeenCalled();
  });
});
