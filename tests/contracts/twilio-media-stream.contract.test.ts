import { describe, expect, it } from "vitest";
import {
  TwilioMediaStreamProvider,
  signTwilioWebhook,
} from "@halo/providers/telephony/twilio-media-stream-provider";
import { telephonyContract } from "./voice-provider-contracts";

/**
 * Reference adapter against the documented Twilio protocol with recorded
 * fixtures. MOCK-VERIFIED only: no live Twilio credentials exist here.
 */

const URL_ = "https://gateway.example/telephony/twilio/inbound";
const INBOUND_FORM = {
  AccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  CallSid: "CA1234567890abcdef1234567890abcdef",
  CallStatus: "ringing",
  Direction: "inbound",
  From: "+919800000001",
  To: "+914000000001",
};

const make = (token: string | null) => new TwilioMediaStreamProvider({ accountSid: "AC1", authToken: token });

telephonyContract("twilio-media-stream", {
  make,
  signedInbound: (secret) => {
    const rawBody = new URLSearchParams(INBOUND_FORM).toString();
    return {
      url: URL_,
      method: "POST",
      headers: { "x-twilio-signature": signTwilioWebhook(secret, URL_, INBOUND_FORM) },
      rawBody,
    };
  },
  startMessage: (parameters) =>
    JSON.stringify({
      event: "start",
      sequenceNumber: "1",
      streamSid: "MZ0000000000000000000000000000",
      start: {
        streamSid: "MZ0000000000000000000000000000",
        accountSid: "AC1",
        callSid: INBOUND_FORM.CallSid,
        tracks: ["inbound"],
        customParameters: parameters,
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      },
    }),
});

describe("Twilio adapter specifics", () => {
  const provider = make("auth-token-value");

  it("answers with TwiML that connects the stream and passes our parameters", () => {
    const answer = provider.answerWithMediaStream({ streamUrl: "wss://gw/media", parameters: { token: "t&1" } });
    expect(answer.contentType).toBe("text/xml");
    expect(answer.body).toContain('<Connect><Stream url="wss://gw/media">');
    expect(answer.body).toContain('<Parameter name="token" value="t&amp;1"/>');
  });

  it("maps call statuses and ignores unknown ones", () => {
    const status = (form: Record<string, string>) =>
      provider.parseWebhook({ url: URL_, method: "POST", headers: {}, rawBody: new URLSearchParams(form).toString() });
    expect(status({ CallSid: "CA1", CallStatus: "no-answer" })).toMatchObject({ kind: "call_status", status: "no_answer" });
    expect(status({ CallSid: "CA1", CallStatus: "completed", CallDuration: "42" })).toMatchObject({ status: "completed", durationSeconds: 42 });
    expect(status({ CallSid: "CA1", CallStatus: "wat" })).toMatchObject({ kind: "ignored" });
    expect(status({ CallStatus: "completed" })).toMatchObject({ kind: "ignored" });
  });

  it("stamps outbound frames with the stream id learned from `start`", () => {
    const codec = provider.createMediaCodec();
    codec.decode(JSON.stringify({ event: "start", start: { streamSid: "MZ9", callSid: "CA1", customParameters: {} } }));
    expect(JSON.parse(codec.encodeAudio(Uint8Array.from([1, 2])))).toMatchObject({ event: "media", streamSid: "MZ9" });
    expect(JSON.parse(codec.encodeClear())).toEqual({ event: "clear", streamSid: "MZ9" });
    expect(JSON.parse(codec.encodeMark("0:1"))).toEqual({ event: "mark", streamSid: "MZ9", mark: { name: "0:1" } });
    expect(codec.decode(JSON.stringify({ event: "dtmf", dtmf: { digit: "5" } }))[0]).toEqual({ type: "dtmf", digit: "5" });
    expect(codec.decode(JSON.stringify({ event: "stop" }))[0]).toEqual({ type: "stop" });
  });

  it("hangs up and transfers through the REST API without ever trusting a model-supplied target", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const p = new TwilioMediaStreamProvider({
      accountSid: "AC1",
      authToken: "tok",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body ?? "") });
        return new Response("{}", { status: 200 });
      },
    });
    await p.hangup("CA1");
    await p.transfer("CA1", { phoneNumber: "+914000000099" });
    expect(calls[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Calls/CA1.json");
    expect(calls[0].body).toContain("Status=completed");
    expect(decodeURIComponent(calls[1].body)).toContain("<Dial>+914000000099</Dial>");
  });

  it("surfaces REST failures instead of reporting success", async () => {
    const p = new TwilioMediaStreamProvider({
      accountSid: "AC1",
      authToken: "tok",
      fetchImpl: async () => new Response("denied", { status: 403 }),
    });
    await expect(p.transfer("CA1", { phoneNumber: "+914000000099" })).rejects.toThrow(/403/);
  });

  it("refuses call control with no credentials", async () => {
    await expect(make(null).hangup("CA1")).rejects.toThrow(/no auth token/);
  });
});
