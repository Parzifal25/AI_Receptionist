import { FakeSttProvider } from "@halo/providers/voice-fakes/fake-stt-provider";
import { FakeTtsProvider } from "@halo/providers/voice-fakes/fake-tts-provider";
import { FakeTelephonyProvider, signFakeWebhook } from "@halo/providers/voice-fakes/fake-telephony-provider";
import { sttContract, telephonyContract, ttsContract } from "./voice-provider-contracts";

sttContract("fake", () => new FakeSttProvider());
ttsContract("fake", () => new FakeTtsProvider({ msPerChar: 40, chunkMs: 50 }));
telephonyContract("fake", {
  make: (secret) => new FakeTelephonyProvider(secret),
  signedInbound: (secret) => {
    const url = "https://gateway.example/telephony/fake/inbound";
    const rawBody = JSON.stringify({ type: "inbound", callId: "CA1", from: "+919800000001", to: "+914000000001" });
    return { url, method: "POST", headers: { "x-fake-signature": signFakeWebhook(secret, url, rawBody) }, rawBody };
  },
  startMessage: (parameters) => JSON.stringify({ event: "start", callId: "CA1", streamId: "S1", parameters }),
});
