import { describe, expect, it } from "vitest";
import type { StreamingSttProvider, SttEvent } from "@halo/ports/streaming-stt-provider";
import type { StreamingTtsProvider } from "@halo/ports/streaming-tts-provider";
import type { TelephonyProvider, WebhookRequest } from "@halo/ports/telephony-provider";

/**
 * Provider contract kits (HALO Phase 3). Every STT/TTS/telephony adapter —
 * fake or real — must pass these. Real adapters run them with credentials in
 * a live job; in CI they run against the deterministic fakes and the
 * reference media-stream adapter with recorded fixtures.
 */

export function sttContract(name: string, make: () => StreamingSttProvider) {
  describe(`STT contract: ${name}`, () => {
    it("declares honest capabilities", () => {
      const caps = make().capabilities();
      expect(caps.languages.length).toBeGreaterThan(0);
      expect(caps.formats.some((f) => f.sampleRate === 8000)).toBe(true);
      for (const f of caps.formats) expect(f.channels).toBe(1);
    });

    it("open never throws; write after close is a no-op; close is idempotent", async () => {
      const events: SttEvent[] = [];
      const stream = make().open(
        { language: "te-IN", alternativeLanguages: ["en-IN"], format: { encoding: "mulaw", sampleRate: 8000, channels: 1 }, interimResults: true, phraseHints: [] },
        (e) => events.push(e),
      );
      stream.write(new Uint8Array(160));
      stream.finalize();
      await stream.close();
      await stream.close();
      expect(() => stream.write(new Uint8Array(160))).not.toThrow();
      const closedAt = events.findIndex((e) => e.type === "closed");
      if (closedAt >= 0) expect(events.slice(closedAt + 1)).toHaveLength(0);
    });
  });
}

export function ttsContract(name: string, make: () => StreamingTtsProvider) {
  const format = { encoding: "pcm16le", sampleRate: 8000, channels: 1 } as const;
  describe(`TTS contract: ${name}`, () => {
    it("yields whole-sample audio in the requested format", async () => {
      let bytes = 0;
      for await (const chunk of make().synthesize({ text: "నమస్కారం", language: "te-IN", format }, new AbortController().signal)) {
        expect(chunk.length % 2).toBe(0);
        bytes += chunk.length;
      }
      expect(bytes).toBeGreaterThan(0);
    });

    it("yields nothing for an already-aborted signal or empty text", async () => {
      const controller = new AbortController();
      controller.abort();
      const provider = make();
      const a: Uint8Array[] = [];
      for await (const c of provider.synthesize({ text: "hello", language: "en-IN", format }, controller.signal)) a.push(c);
      for await (const c of provider.synthesize({ text: "   ", language: "en-IN", format }, new AbortController().signal)) a.push(c);
      expect(a).toHaveLength(0);
    });

    it("stops promptly on mid-stream abort without throwing", async () => {
      const controller = new AbortController();
      let chunks = 0;
      const long = "This sentence is long enough to produce several chunks of synthesized audio for the test.";
      for await (const _chunk of make().synthesize({ text: long, language: "en-IN", format }, controller.signal)) {
        chunks += 1;
        if (chunks === 1) controller.abort();
      }
      expect(chunks).toBeLessThanOrEqual(2);
    });
  });
}

export function telephonyContract(
  name: string,
  opts: {
    make: (secret: string | null) => TelephonyProvider;
    /** Build a correctly signed inbound-call webhook for this adapter. */
    signedInbound: (secret: string) => WebhookRequest;
    /** A raw media-stream "start" message carrying the given parameters. */
    startMessage: (params: Record<string, string>) => string;
  },
) {
  describe(`Telephony contract: ${name}`, () => {
    const secret = "contract-secret-value";

    it("fails closed when no signing secret is configured", () => {
      expect(opts.make(null).verifyWebhook(opts.signedInbound(secret))).toEqual({ ok: false, reason: "not_configured" });
      expect(opts.make("").verifyWebhook(opts.signedInbound(secret))).toEqual({ ok: false, reason: "not_configured" });
    });

    it("accepts a valid signature and rejects missing/invalid/tampered ones", () => {
      const provider = opts.make(secret);
      const good = opts.signedInbound(secret);
      expect(provider.verifyWebhook(good)).toEqual({ ok: true });
      const headers = Object.fromEntries(Object.entries(good.headers).filter(([k]) => !/signature/.test(k)));
      expect(provider.verifyWebhook({ ...good, headers })).toMatchObject({ ok: false, reason: "missing_signature" });
      expect(provider.verifyWebhook(opts.signedInbound("some-other-secret"))).toMatchObject({ ok: false, reason: "invalid_signature" });
      expect(provider.verifyWebhook({ ...good, rawBody: `${good.rawBody}&x=1` })).toMatchObject({ ok: false });
      expect(provider.verifyWebhook({ ...good, url: `${good.url}?evil=1` })).toMatchObject({ ok: false });
    });

    it("parses a verified inbound call", () => {
      const event = opts.make(secret).parseWebhook(opts.signedInbound(secret));
      expect(event.kind).toBe("inbound_call");
    });

    it("media codec: never throws on garbage, round-trips audio and start parameters", () => {
      const codec = opts.make(secret).createMediaCodec();
      expect(codec.format).toMatchObject({ sampleRate: 8000, channels: 1 });
      expect(() => codec.decode("not json at all")).not.toThrow();
      expect(codec.decode("{}")[0]?.type ?? "malformed").toBe("malformed");
      const start = codec.decode(opts.startMessage({ token: "abc" }));
      expect(start[0]).toMatchObject({ type: "start", parameters: { token: "abc" } });
      const audio = Uint8Array.from([1, 2, 3, 255]);
      const decoded = codec.decode(codec.encodeAudio(audio));
      expect(decoded[0]?.type).toBe("audio");
      if (decoded[0]?.type === "audio") expect(Array.from(decoded[0].audio)).toEqual([1, 2, 3, 255]);
      expect(typeof codec.encodeClear()).toBe("string");
      expect(typeof codec.encodeMark("0:1")).toBe("string");
    });

    it("answers with media-stream instructions that carry our parameters", () => {
      const answer = opts.make(secret).answerWithMediaStream({ streamUrl: "wss://gateway.example/media", parameters: { token: "tok-123" } });
      expect(answer.body).toContain("wss://gateway.example/media");
      expect(answer.body).toContain("tok-123");
    });
  });
}
