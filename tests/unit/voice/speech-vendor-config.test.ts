import { describe, expect, it } from "vitest";
import { createSttProvider, createTtsProvider } from "@halo/providers/voice-vendors/factory";
import { loadGatewayConfig } from "../../../services/voice-gateway/config";

/**
 * Phase 4.5 Sprint 1 — selecting a real speech vendor must fail CLOSED.
 *
 * A gateway that answers a call it cannot transcribe or cannot speak is
 * worse than one that refuses to start, because the caller is already on the
 * line by the time anyone finds out. So the credential is a startup
 * requirement, not a runtime discovery.
 */

const BASE_ENV = {
  VOICE_GATEWAY_PUBLIC_WS_URL: "wss://gateway.test/media",
  VOICE_STREAM_TOKEN_SECRET: "stream-token-secret-at-least-32-chars",
  TELEPHONY_PROVIDER: "fake",
  VOICE_FAKE_WEBHOOK_SECRET: "fake-webhook-secret-value",
};

describe("speech vendor selection", () => {
  it("defaults to the fakes, so an unconfigured deployment behaves exactly as before", () => {
    const config = loadGatewayConfig(BASE_ENV);
    expect(config.sttProvider).toBe("fake");
    expect(config.ttsProvider).toBe("fake");
    expect(createSttProvider({ provider: config.sttProvider }).name).toBe("fake-stt");
    expect(createTtsProvider({ provider: config.ttsProvider }).name).toBe("fake-tts");
  });

  it("refuses to start with a real STT vendor and no credential", () => {
    expect(() => loadGatewayConfig({ ...BASE_ENV, VOICE_STT_PROVIDER: "sarvam" })).toThrow(/VOICE_STT_API_KEY is required/);
  });

  it("refuses to start with a real TTS vendor and no credential", () => {
    expect(() =>
      loadGatewayConfig({ ...BASE_ENV, VOICE_TTS_PROVIDER: "sarvam", VOICE_TTS_DEFAULT_VOICE: "anushka" }),
    ).toThrow(/VOICE_TTS_API_KEY is required/);
  });

  it("refuses to start with a real TTS vendor and no voice — the platform does not pick one", () => {
    expect(() => loadGatewayConfig({ ...BASE_ENV, VOICE_TTS_PROVIDER: "sarvam", VOICE_TTS_API_KEY: "key" })).toThrow(
      /VOICE_TTS_DEFAULT_VOICE is required/,
    );
  });

  it("builds the real adapters once fully configured", () => {
    const config = loadGatewayConfig({
      ...BASE_ENV,
      VOICE_STT_PROVIDER: "sarvam",
      VOICE_STT_API_KEY: "stt-key",
      VOICE_STT_MODE: "codemix",
      VOICE_TTS_PROVIDER: "sarvam",
      VOICE_TTS_API_KEY: "tts-key",
      VOICE_TTS_DEFAULT_VOICE: "anushka",
    });
    expect(config.sttMode).toBe("codemix");
    const stt = createSttProvider({ provider: config.sttProvider, apiKey: config.sttApiKey, mode: config.sttMode });
    const tts = createTtsProvider({
      provider: config.ttsProvider,
      apiKey: config.ttsApiKey,
      defaultSpeaker: config.ttsDefaultVoice,
    });
    expect(stt.name).toBe("sarvam-stt");
    expect(tts.name).toBe("sarvam-tts");
    // Both must be able to carry a Telugu call over telephony-band audio, or
    // selecting them was pointless.
    expect(stt.capabilities().languages).toContain("te-IN");
    expect(stt.capabilities().formats).toContainEqual({ encoding: "mulaw", sampleRate: 8000, channels: 1 });
    expect(tts.capabilities().languages).toContain("te-IN");
    expect(tts.capabilities().formats).toContainEqual({ encoding: "mulaw", sampleRate: 8000, channels: 1 });
  });

  it("rejects an unknown vendor name rather than falling back to a fake", () => {
    expect(() => loadGatewayConfig({ ...BASE_ENV, VOICE_STT_PROVIDER: "whisper-somewhere" })).toThrow();
    expect(() => loadGatewayConfig({ ...BASE_ENV, VOICE_TTS_PROVIDER: "some-vendor" })).toThrow();
  });

  it("refuses a vendor mode the adapter does not implement", () => {
    expect(() =>
      loadGatewayConfig({ ...BASE_ENV, VOICE_STT_PROVIDER: "sarvam", VOICE_STT_API_KEY: "k", VOICE_STT_MODE: "translate" }),
    ).toThrow();
  });

  it("requires the credential at construction too, not only in the config schema", () => {
    expect(() => createSttProvider({ provider: "sarvam" })).toThrow(/VOICE_STT_API_KEY/);
    expect(() => createTtsProvider({ provider: "sarvam", apiKey: "k" })).toThrow(/VOICE_TTS_DEFAULT_VOICE/);
  });
});
