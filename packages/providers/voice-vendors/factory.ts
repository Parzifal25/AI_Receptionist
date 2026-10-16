import { FallbackSttProvider } from "./fallback-stt-provider";
import { FallbackTtsProvider } from "./fallback-tts-provider";
import { logger } from "@halo/platform/logger";
import type { StreamingSttProvider } from "@halo/ports/streaming-stt-provider";
import type { StreamingTtsProvider } from "@halo/ports/streaming-tts-provider";
import { FakeSttProvider } from "../voice-fakes/fake-stt-provider";
import { FakeTtsProvider } from "../voice-fakes/fake-tts-provider";
import { getLocalSpeechEngine } from "./local-speech-engine";
import { LocalSttProvider } from "./local-stt-provider";
import { LocalTtsProvider } from "./local-tts-provider";
import { SarvamSttProvider, type SarvamSttMode } from "./sarvam-stt-provider";
import { SarvamTtsProvider } from "./sarvam-tts-provider";

/**
 * HALO Phase 4.5 — speech vendor selection.
 *
 * These factories take an explicit, already-validated configuration object
 * rather than reading the environment. The voice gateway owns exactly one
 * env schema (`services/voice-gateway/config.ts`) which fails closed at
 * startup, so a missing credential is a refusal to boot, never a call that
 * answers and then cannot speak. Keeping `process.env` out of the adapters
 * is also what lets the contract tests run them without a fake environment.
 *
 * Phase B adds `local` (in-process sherpa-onnx models, no credential) and an
 * optional `fallback`. A fallback is for a provider that FAILS AT RUN TIME
 * with a recoverable error; it never stands in for a provider that was
 * configured wrong. A missing credential or model directory throws here.
 *
 * Sarvam models are required too (owner decision 2026-10-16, W4.2): the
 * gateway and the Pipecat worker used to fall back to different built-in
 * models, so one deployment could run two model pairs. The pair itself is
 * still the open pilot decision D17; nothing here chooses it.
 */

const log = logger.child({ component: "local-speech" });

export const STT_PROVIDER_NAMES = ["fake", "sarvam", "local"] as const;
export const TTS_PROVIDER_NAMES = ["fake", "sarvam", "local"] as const;

export type SttProviderName = (typeof STT_PROVIDER_NAMES)[number];
export type TtsProviderName = (typeof TTS_PROVIDER_NAMES)[number];

export interface SttFactoryConfig {
  endpointing?: "vad" | "manual";
  fallback?: Omit<SttFactoryConfig, "fallback">;
  provider: SttProviderName;
  apiKey?: string;
  model?: string;
  mode?: SarvamSttMode;
  baseUrl?: string;
  /** `local` only: directory provisioned by services/pipecat-worker/setup_local_speech.py. */
  modelDir?: string;
  threads?: number;
}

export interface TtsFactoryConfig {
  fallback?: Omit<TtsFactoryConfig, "fallback">;
  provider: TtsProviderName;
  apiKey?: string;
  model?: string;
  /** Used only when the agent version configures no `voice.ttsVoice`. */
  defaultSpeaker?: string;
  baseUrl?: string;
  /** `local` only: directory provisioned by services/pipecat-worker/setup_local_speech.py. */
  modelDir?: string;
  threads?: number;
}

export function createSttProvider(config: SttFactoryConfig): StreamingSttProvider {
  if (config.fallback) return new FallbackSttProvider([createSttProvider({ ...config, fallback: undefined }), createSttProvider(config.fallback)], undefined, { onChange: circuitLog("stt") });
  switch (config.provider) {
    case "sarvam":
      return new SarvamSttProvider({
        endpointing: config.endpointing,
        apiKey: requireValue(config.apiKey, "VOICE_STT_API_KEY", "sarvam"),
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        model: requireValue(config.model?.trim(), "VOICE_STT_MODEL", "sarvam"),
        ...(config.mode ? { mode: config.mode } : {}),
      });
    case "local":
      return new LocalSttProvider(getLocalSpeechEngine(requireValue(config.modelDir, "VOICE_LOCAL_MODEL_DIR", "local"), config.threads),
        { onMetric: metric => (metric.event === "error" ? log.warn : log.info).call(log, "local stt", metric) });
    case "fake":
      return new FakeSttProvider();
  }
}

export function createTtsProvider(config: TtsFactoryConfig): StreamingTtsProvider {
  if (config.fallback) return new FallbackTtsProvider([{ provider: createTtsProvider({ ...config, fallback: undefined }) }, { provider: createTtsProvider(config.fallback), voiceId: config.fallback.defaultSpeaker }], { onChange: circuitLog("tts") });
  switch (config.provider) {
    case "sarvam":
      return new SarvamTtsProvider({
        apiKey: requireValue(config.apiKey, "VOICE_TTS_API_KEY", "sarvam"),
        defaultSpeaker: requireValue(config.defaultSpeaker, "VOICE_TTS_DEFAULT_VOICE", "sarvam"),
        model: requireValue(config.model?.trim(), "VOICE_TTS_MODEL", "sarvam"),
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      });
    case "local":
      return new LocalTtsProvider(getLocalSpeechEngine(requireValue(config.modelDir, "VOICE_LOCAL_MODEL_DIR", "local"), config.threads),
        { onMetric: metric => (metric.event === "error" ? log.warn : log.info).call(log, "local tts", metric) });
    case "fake":
      return new FakeTtsProvider();
  }
}

/** `open` means the primary is being skipped and callers are on the fallback. */
function circuitLog(kind: "stt" | "tts") {
  return (change: { provider: string; state: string; cooldownMs: number }) =>
    (change.state === "closed" ? log.info : log.warn).call(log, "speech provider circuit", { kind, ...change });
}

function requireValue(value: string | undefined, variable: string, provider: string): string {
  if (!value) throw new Error(`${variable} is required when the ${provider} speech provider is selected`);
  return value;
}
