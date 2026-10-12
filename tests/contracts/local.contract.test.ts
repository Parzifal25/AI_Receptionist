import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe } from "vitest";
import { getLocalSpeechEngine } from "@halo/providers/voice-vendors/local-speech-engine";
import { LocalSttProvider } from "@halo/providers/voice-vendors/local-stt-provider";
import { LocalTtsProvider } from "@halo/providers/voice-vendors/local-tts-provider";
import { StandInSpeechEngine } from "../mocks/local-speech";
import { sttContract, ttsContract } from "./voice-provider-contracts";

/**
 * HALO Phase B — the local providers against the SAME contract kits as the
 * fakes and Sarvam. Offline with a stand-in engine; with
 * VOICE_LOCAL_MODEL_DIR set, again with the real models loaded.
 */
sttContract("local", () => new LocalSttProvider(new StandInSpeechEngine()));
ttsContract("local", () => new LocalTtsProvider(new StandInSpeechEngine()));

const modelDir = process.env.VOICE_LOCAL_MODEL_DIR ?? "";
describe.skipIf(!modelDir || !existsSync(join(modelDir, "manifest.json")))("real local models", { timeout: 120_000 }, () => {
  sttContract("local (real models)", () => new LocalSttProvider(getLocalSpeechEngine(modelDir)));
  ttsContract("local (real models)", () => new LocalTtsProvider(getLocalSpeechEngine(modelDir)));
});
