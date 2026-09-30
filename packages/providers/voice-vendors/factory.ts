import { SelfHostedSttProvider, SelfHostedTtsProvider } from "./self-hosted-speech";
import { FallbackSttProvider } from "./fallback-stt-provider";
import { FallbackTtsProvider } from "./fallback-tts-provider";
import type { StreamingSttProvider } from "@halo/ports/streaming-stt-provider";
import type { StreamingTtsProvider } from "@halo/ports/streaming-tts-provider";
import { FakeSttProvider } from "../voice-fakes/fake-stt-provider";
import { FakeTtsProvider } from "../voice-fakes/fake-tts-provider";
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
 */

export const STT_PROVIDER_NAMES = ["fake", "sarvam", "self-hosted"] as const;
export const TTS_PROVIDER_NAMES = ["fake", "sarvam", "self-hosted"] as const;

export type SttProviderName = (typeof STT_PROVIDER_NAMES)[number];
export type TtsProviderName = (typeof TTS_PROVIDER_NAMES)[number];

export interface SttFactoryConfig {
  fallback?: Omit<SttFactoryConfig, "fallback">;
  provider: SttProviderName;
  apiKey?: string;
  model?: string;
  mode?: SarvamSttMode;
  baseUrl?: string;
}

export interface TtsFactoryConfig {
  fallback?: Omit<TtsFactoryConfig, "fallback">;
  provider: TtsProviderName;
  apiKey?: string;
  model?: string;
  /** Used only when the agent version configures no `voice.ttsVoice`. */
  defaultSpeaker?: string;
  baseUrl?: string;
}

export function createSttProvider(config: SttFactoryConfig): StreamingSttProvider {
  if (config.fallback && config.provider === "sarvam" && !config.apiKey) return createSttProvider(config.fallback);
  if (config.fallback) return new FallbackSttProvider([createSttProvider({ ...config, fallback: undefined }), createSttProvider(config.fallback)]);
  switch (config.provider) {
    case "self-hosted":
      return new SelfHostedSttProvider({ baseUrl: requireValue(config.baseUrl, "VOICE_STT_BASE_URL", "self-hosted"), apiKey: config.apiKey });
    case "sarvam":
      return new SarvamSttProvider({
        apiKey: requireValue(config.apiKey, "VOICE_STT_API_KEY", "sarvam"),
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(config.model ? { model: config.model } : {}),
        ...(config.mode ? { mode: config.mode } : {}),
      });
    case "fake":
      return new FakeSttProvider();
  }
}

export function createTtsProvider(config: TtsFactoryConfig): StreamingTtsProvider {
  if (config.fallback && config.provider === "sarvam" && (!config.apiKey || !config.defaultSpeaker)) return createTtsProvider(config.fallback);
  if (config.fallback) return new FallbackTtsProvider([{ provider: createTtsProvider({ ...config, fallback: undefined }) }, { provider: createTtsProvider(config.fallback), voiceId: config.fallback.defaultSpeaker }]);
  switch (config.provider) {
    case "self-hosted":
      return new SelfHostedTtsProvider({ baseUrl: requireValue(config.baseUrl, "VOICE_TTS_BASE_URL", "self-hosted"), apiKey: config.apiKey });
    case "sarvam":
      return new SarvamTtsProvider({
        apiKey: requireValue(config.apiKey, "VOICE_TTS_API_KEY", "sarvam"),
        defaultSpeaker: requireValue(config.defaultSpeaker, "VOICE_TTS_DEFAULT_VOICE", "sarvam"),
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(config.model ? { model: config.model } : {}),
      });
    case "fake":
      return new FakeTtsProvider();
  }
}

function requireValue(value: string | undefined, variable: string, provider: string): string {
  if (!value) throw new Error(`${variable} is required when the ${provider} speech provider is selected`);
  return value;
}
