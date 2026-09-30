import { describe, expect, it } from "vitest";
import { VoiceProfiles } from "@halo/providers/voice-vendors/profiles";
import { parseAgentConfig } from "@halo/core/domain/agents";
import { buildSessionConfig } from "@halo/voice/session-config";
const wire = { encoding: "mulaw" as const, sampleRate: 8000, channels: 1 as const };
const json = JSON.stringify({ alpha: { local: { sampleRate: 8000, stt: { provider: "self-hosted", baseUrl: "http://speech.local" },
  tts: { provider: "self-hosted", baseUrl: "http://speech.local" } } } });
describe("tenant voice profiles", () => {
  it("selects configured providers only within the profile tenant", () => {
    const profiles = new VoiceProfiles(json);
    expect(profiles.resolve("alpha", "local", wire).stt.name).toBe("self-hosted-stt");
    expect(() => profiles.resolve("beta", "local", wire)).toThrow("tenant");
    expect(() => profiles.resolve("alpha", "missing", wire)).toThrow("tenant");
  });
  it("does not silently synthesize at a mismatched sample rate", () => {
    expect(() => new VoiceProfiles(json).resolve("alpha", "local", { ...wire, sampleRate: 16000 })).toThrow("sample rate");
  });
  it("pins only a profile reference in agent config and propagates it to media", () => {
    const config = parseAgentConfig({ voice: { profileId: "local", prompts: { greeting: "AI assistant", reprompt: "Hello?",
      goodbye: "Goodbye", turnFailure: "Try again", transferAnnounce: "Connecting", transferFailed: "Unavailable" } } })!;
    const result = buildSessionConfig(config);
    expect(result).toMatchObject({ ok: true, config: { profileId: "local" } });
    expect(JSON.stringify(config)).not.toContain("speech.local");
  });
});
