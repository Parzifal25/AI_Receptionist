import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalSpeechEngine } from "@halo/providers/voice-vendors/local-speech-engine";

/** Deterministic stand-in for the sherpa-onnx engine: no models, records what it was asked. */
export class StandInSpeechEngine implements LocalSpeechEngine {
  readonly sttLanguages = ["te-IN", "en-IN"];
  voiceLanguages = ["en", "te"];
  readonly voiceIds = ["te-voice", "en-voice"];
  readonly heard: { samples: number; sampleRate: number }[] = [];
  readonly spoken: { language: string; text: string }[] = [];
  transcript = "నమస్కారం";
  failure: Error | null = null;

  async transcribe(samples: Float32Array, sampleRate: number): Promise<string> {
    if (this.failure) throw this.failure;
    this.heard.push({ samples: samples.length, sampleRate });
    return this.transcript;
  }

  async synthesize(language: string, text: string, _speed: number, onAudio: (samples: Float32Array, sampleRate: number) => boolean): Promise<void> {
    if (this.failure) throw this.failure;
    this.spoken.push({ language, text });
    // Two half-second "sentences" at the voice's native rate.
    for (let sentence = 0; sentence < 2; sentence++) {
      await new Promise(resolve => setTimeout(resolve, 1));
      if (!onAudio(new Float32Array(11025).fill(0.1), 22050)) return;
    }
  }

  resample(samples: Float32Array, from: number, to: number): Float32Array {
    return from === to ? samples : new Float32Array(Math.round((samples.length * to) / from)).fill(samples[0] ?? 0);
  }
}

/** A model directory whose manifest is valid and whose files exist (empty): enough to pass startup validation. */
export function localModelDirFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "halo-local-speech-"));
  for (const sub of ["stt", "tts/te", "tts/en", "tts/espeak-ng-data"]) mkdirSync(join(dir, sub), { recursive: true });
  const files = ["stt/model.int8.onnx", "stt/tokens.txt", "tts/te/model.onnx", "tts/te/tokens.txt", "tts/en/model.onnx", "tts/en/tokens.txt"];
  for (const file of files) writeFileSync(join(dir, file), "");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    version: 1,
    stt: { engine: "sherpa-onnx", type: "omnilingual-ctc", id: "fixture", model: files[0], tokens: files[1], sampleRate: 16000, languages: ["te-IN", "en-IN"] },
    tts: { engine: "sherpa-onnx", type: "vits-piper", dataDir: "tts/espeak-ng-data", voices: {
      te: { id: "te-voice", model: files[2], tokens: files[3], sampleRate: 22050 }, en: { id: "en-voice", model: files[4], tokens: files[5], sampleRate: 22050 } } },
  }));
  return dir;
}
