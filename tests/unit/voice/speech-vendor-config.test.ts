import { describe, expect, it } from "vitest";
import { createSttProvider, createTtsProvider } from "@halo/providers/voice-vendors/factory";
import { loadGatewayConfig } from "../../../services/voice-gateway/config";
import { localModelDirFixture } from "../../mocks/local-speech";

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

/** Synthetic names: the real pair is the open pilot decision D17. */
const MODELS = { VOICE_STT_MODEL: "synthetic-stt-model", VOICE_TTS_MODEL: "synthetic-tts-model" };
const STT_MODEL = MODELS.VOICE_STT_MODEL;
const TTS_MODEL = MODELS.VOICE_TTS_MODEL;

describe("speech vendor selection", () => {
  it("does not silently use fake speech on a real carrier", () => {
    expect(() => loadGatewayConfig({ ...BASE_ENV, TELEPHONY_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "account", TWILIO_AUTH_TOKEN: "token" })).toThrow();
  });

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
      ...MODELS,
    });
    expect(config.sttMode).toBe("codemix");
    const stt = createSttProvider({ provider: config.sttProvider, apiKey: config.sttApiKey, mode: config.sttMode, model: config.sttModel });
    const tts = createTtsProvider({
      provider: config.ttsProvider,
      apiKey: config.ttsApiKey,
      defaultSpeaker: config.ttsDefaultVoice,
      model: config.ttsModel,
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

  // W4.2 (owner decision 2026-10-16): the gateway and the Pipecat worker used
  // to fall back to different built-in model pairs. Neither has one now; the
  // pair itself is the open pilot decision D17.
  it("refuses to start with Sarvam and no model — the platform does not pick the pair", () => {
    const sarvam = { ...BASE_ENV, SARVAM_API: "shared", VOICE_STT_PROVIDER: "sarvam", VOICE_TTS_PROVIDER: "sarvam", VOICE_TTS_DEFAULT_VOICE: "anushka" };
    expect(() => loadGatewayConfig({ ...sarvam, VOICE_TTS_MODEL: TTS_MODEL })).toThrow(/VOICE_STT_MODEL is required/);
    expect(() => loadGatewayConfig({ ...sarvam, VOICE_STT_MODEL: STT_MODEL })).toThrow(/VOICE_TTS_MODEL is required/);
    // A Sarvam fallback needs its model up front too, not at the first outage.
    const local = { ...BASE_ENV, SARVAM_API: "shared", VOICE_STT_PROVIDER: "local", VOICE_TTS_PROVIDER: "local", VOICE_LOCAL_MODEL_DIR: localModelDirFixture(), VOICE_TTS_DEFAULT_VOICE: "anushka" };
    expect(() => loadGatewayConfig({ ...local, VOICE_STT_FALLBACK_PROVIDER: "sarvam" })).toThrow(/VOICE_STT_MODEL is required/);
    expect(() => loadGatewayConfig({ ...local, VOICE_TTS_FALLBACK_PROVIDER: "sarvam" })).toThrow(/VOICE_TTS_MODEL is required/);
    expect(loadGatewayConfig({ ...sarvam, ...MODELS })).toMatchObject({ sttModel: STT_MODEL, ttsModel: TTS_MODEL });
    // Blank is unset, not a model name the vendor would only reject mid-call.
    expect(() => loadGatewayConfig({ ...sarvam, ...MODELS, VOICE_STT_MODEL: "  " })).toThrow(/VOICE_STT_MODEL is required/);
    expect(() => createTtsProvider({ provider: "sarvam", apiKey: "k", defaultSpeaker: "anushka", model: " " })).toThrow(/VOICE_TTS_MODEL/);
    // Fakes and local speech never needed a vendor model and still do not.
    expect(loadGatewayConfig(BASE_ENV)).toMatchObject({ sttModel: undefined, ttsModel: undefined });
  });

  it("requires the model at construction too, so a tenant profile cannot omit it", () => {
    expect(() => createSttProvider({ provider: "sarvam", apiKey: "k" })).toThrow(/VOICE_STT_MODEL/);
    expect(() => createTtsProvider({ provider: "sarvam", apiKey: "k", defaultSpeaker: "anushka" })).toThrow(/VOICE_TTS_MODEL/);
  });
});

describe("local speech and provider fallback (Phase B)", () => {
  it("selects the local providers with a model directory and no credential", () => {
    const config = loadGatewayConfig({ ...BASE_ENV, VOICE_STT_PROVIDER: "local", VOICE_TTS_PROVIDER: "local", VOICE_LOCAL_MODEL_DIR: localModelDirFixture() });
    expect(config).toMatchObject({ sttProvider: "local", ttsProvider: "local", sttApiKey: undefined, ttsApiKey: undefined });
    const stt = createSttProvider({ provider: config.sttProvider, modelDir: config.localModelDir });
    const tts = createTtsProvider({ provider: config.ttsProvider, modelDir: config.localModelDir });
    expect([stt.name, tts.name]).toEqual(["local-stt", "local-tts"]);
    expect(stt.capabilities()).toMatchObject({ languages: ["te-IN", "en-IN"], interimResults: false, reportsConfidence: false });
    expect(stt.capabilities().formats).toContainEqual({ encoding: "mulaw", sampleRate: 8000, channels: 1 });
    expect(tts.capabilities().languages).toEqual(["en-IN", "te-IN"]);
  });

  it("refuses to start with local speech and no usable model directory", () => {
    expect(() => loadGatewayConfig({ ...BASE_ENV, VOICE_STT_PROVIDER: "local" })).toThrow(/VOICE_LOCAL_MODEL_DIR is required/);
    expect(() => loadGatewayConfig({ ...BASE_ENV, VOICE_TTS_FALLBACK_PROVIDER: "local" })).toThrow(/VOICE_LOCAL_MODEL_DIR is required/);
    expect(() => createSttProvider({ provider: "local" })).toThrow(/VOICE_LOCAL_MODEL_DIR/);
    expect(() => createTtsProvider({ provider: "local", modelDir: "/nonexistent/halo-models" })).toThrow(/manifest/);
  });

  it("routes a configured fallback and validates everything the fallback needs", () => {
    const modelDir = localModelDirFixture();
    const config = loadGatewayConfig({ ...BASE_ENV, SARVAM_API: "shared", VOICE_STT_PROVIDER: "sarvam", VOICE_TTS_PROVIDER: "sarvam", VOICE_TTS_DEFAULT_VOICE: "anushka",
      VOICE_STT_FALLBACK_PROVIDER: "local", VOICE_TTS_FALLBACK_PROVIDER: "local", VOICE_LOCAL_MODEL_DIR: modelDir, ...MODELS });
    expect(config).toMatchObject({ sttFallbackProvider: "local", ttsFallbackProvider: "local" });
    expect(createSttProvider({ provider: "sarvam", apiKey: "k", model: STT_MODEL, fallback: { provider: "local", modelDir } }).name).toBe("fallback-stt");
    expect(createTtsProvider({ provider: "sarvam", apiKey: "k", defaultSpeaker: "anushka", model: TTS_MODEL, fallback: { provider: "local", modelDir } }).name).toBe("fallback-tts");
    // The reverse direction: Sarvam as the fallback still needs its credential and voice up front.
    const reverse = { ...BASE_ENV, VOICE_STT_PROVIDER: "local", VOICE_TTS_PROVIDER: "local", VOICE_LOCAL_MODEL_DIR: modelDir };
    expect(() => loadGatewayConfig({ ...reverse, VOICE_STT_FALLBACK_PROVIDER: "sarvam" })).toThrow(/VOICE_STT_API_KEY is required/);
    expect(() => loadGatewayConfig({ ...reverse, VOICE_TTS_FALLBACK_PROVIDER: "sarvam", SARVAM_API: "shared" })).toThrow(/VOICE_TTS_DEFAULT_VOICE is required/);
    expect(loadGatewayConfig({ ...reverse, VOICE_STT_FALLBACK_PROVIDER: "sarvam", SARVAM_API: "shared", ...MODELS }).sttApiKey).toBe("shared");
    expect(() => loadGatewayConfig({ ...reverse, VOICE_STT_FALLBACK_PROVIDER: "local" })).toThrow(/must differ/);
  });

  it("never falls back from a misconfigured primary: a missing credential is still an error", () => {
    const modelDir = localModelDirFixture();
    expect(() => createSttProvider({ provider: "sarvam", fallback: { provider: "local", modelDir } })).toThrow(/VOICE_STT_API_KEY/);
    expect(() => createTtsProvider({ provider: "sarvam", fallback: { provider: "local", modelDir } })).toThrow(/VOICE_TTS_API_KEY/);
    expect(() => createSttProvider({ provider: "sarvam", apiKey: "k", model: STT_MODEL, fallback: { provider: "local" } })).toThrow(/VOICE_LOCAL_MODEL_DIR/);
  });

  it("leaves the Sarvam-only configuration exactly as it was", () => {
    const config = loadGatewayConfig({ ...BASE_ENV, SARVAM_API: "shared", VOICE_STT_PROVIDER: "sarvam", VOICE_TTS_PROVIDER: "sarvam", VOICE_TTS_DEFAULT_VOICE: "anushka", ...MODELS });
    expect(config).toMatchObject({ sttProvider: "sarvam", ttsProvider: "sarvam", sttApiKey: "shared", ttsApiKey: "shared" });
    expect([config.sttFallbackProvider, config.ttsFallbackProvider, config.localModelDir]).toEqual([undefined, undefined, undefined]);
    // Bare vendor adapters: no wrapper in the path.
    expect(createSttProvider({ provider: "sarvam", apiKey: "k", model: STT_MODEL }).name).toBe("sarvam-stt");
    expect(createTtsProvider({ provider: "sarvam", apiKey: "k", defaultSpeaker: "anushka", model: TTS_MODEL }).name).toBe("sarvam-tts");
  });
});

it("accepts the existing shared Sarvam credential names with explicit keys taking precedence", () => {
  for (const name of ["SARVAM_API_KEY", "SARVAM_API"]) {
    const config = loadGatewayConfig({ ...BASE_ENV, VOICE_STT_PROVIDER: "sarvam", VOICE_TTS_PROVIDER: "sarvam", VOICE_TTS_DEFAULT_VOICE: "shubh", [name]: "shared-test-key", ...MODELS });
    expect(config.sttApiKey).toBe("shared-test-key"); expect(config.ttsApiKey).toBe("shared-test-key");
  }
  const config = loadGatewayConfig({ ...BASE_ENV, SARVAM_API: "shared", VOICE_STT_API_KEY: "explicit-stt", VOICE_TTS_API_KEY: "explicit-tts", VOICE_WEB_TTS_SAMPLE_RATE: "16000" });
  expect(config.sttApiKey).toBe("explicit-stt"); expect(config.ttsApiKey).toBe("explicit-tts"); expect(config.webTtsSampleRate).toBe(16000);
  expect(() => loadGatewayConfig({ ...BASE_ENV, VOICE_WEB_TTS_SAMPLE_RATE: "44100" })).toThrow();
});

it("never forwards shared Sarvam credentials to a non-Sarvam provider", () => {
  const config = loadGatewayConfig({ ...BASE_ENV, SARVAM_API: "shared-sarvam-key", VOICE_STT_PROVIDER: "fake", VOICE_TTS_PROVIDER: "fake" });
  expect(config.sttApiKey).toBeUndefined(); expect(config.ttsApiKey).toBeUndefined();
});
