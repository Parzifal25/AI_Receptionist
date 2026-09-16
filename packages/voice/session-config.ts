import type { AgentConfig } from "@halo/core/domain/agents";
import { DEFAULT_ENDPOINTER_CONFIG } from "./endpointer";
import { DEFAULT_VOICE_SESSION_CONFIG, type VoiceSessionConfig } from "./voice-session";

/**
 * HALO Phase 3 — agent configuration → voice session configuration.
 *
 * Everything a phone call says outside the model (greeting with the AI
 * disclosure, silence reprompts, goodbye, failure and transfer lines) is
 * tenant-authored content in `agent_versions.config.voice.prompts`, in the
 * agent's own language. The platform NEVER invents or translates these, so an
 * agent missing the required lines is not answered at all: `buildSessionConfig`
 * returns the missing keys and the gateway rejects the call. Silence is the
 * honest failure here — a caller hearing an English machine line from a Telugu
 * agent is worse than a busy signal.
 */

export const REQUIRED_VOICE_PROMPTS = ["greeting", "reprompt", "goodbye", "turnFailure", "transferAnnounce", "transferFailed"] as const;

export type VoicePromptKey = (typeof REQUIRED_VOICE_PROMPTS)[number];

export type BuildSessionConfigResult =
  | { ok: true; config: VoiceSessionConfig }
  | { ok: false; missing: VoicePromptKey[] };

export function buildSessionConfig(agentConfig: AgentConfig, overrides: Partial<VoiceSessionConfig> = {}): BuildSessionConfigResult {
  const prompts = agentConfig.voice.prompts;
  const missing = REQUIRED_VOICE_PROMPTS.filter((key) => !prompts[key]?.trim());
  if (missing.length > 0) return { ok: false, missing };

  const voice = agentConfig.voice;
  const config: VoiceSessionConfig = {
    ...DEFAULT_VOICE_SESSION_CONFIG,
    language: agentConfig.language.primary || "en",
    alternativeLanguages: agentConfig.language.fallbacks.slice(0, 4),
    phraseHints: voice.phraseHints,
    ...(voice.ttsVoice ? { voiceId: voice.ttsVoice } : {}),
    ...(voice.speakingRate ? { speakingRate: voice.speakingRate } : {}),
    prompts: {
      greeting: prompts.greeting,
      reprompt: prompts.reprompt,
      goodbye: prompts.goodbye,
      turnFailure: prompts.turnFailure,
      transferAnnounce: prompts.transferAnnounce,
      transferFailed: prompts.transferFailed,
    },
    endpointer: { ...DEFAULT_ENDPOINTER_CONFIG, endHangoverMs: voice.endOfSpeechMs },
    bargeIn: { enabled: voice.bargeIn, minSpeechMs: voice.bargeInMinSpeechMs },
    silence: { timeoutMs: voice.silenceTimeoutMs, maxReprompts: voice.maxSilentReprompts },
    maxCallDurationMs: voice.maxCallDurationMs,
    ...overrides,
  };
  return { ok: true, config };
}
