import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { UnspeakableTextError } from "./local-tts-text";

/**
 * HALO Phase B — local, credential-free speech (shared engine).
 *
 * In-process inference through sherpa-onnx (ONNX Runtime): no service, no
 * network, no credential. The same model directory serves this process and
 * the Pipecat worker (services/pipecat-worker/local_speech.py); which models
 * are used is decided by its `manifest.json`, written by
 * services/pipecat-worker/setup_local_speech.py, never by a default here.
 *
 * Selecting `local` is an availability decision, not a quality claim. The
 * measured gap to the Sarvam reference — large for Telugu STT — is recorded
 * in docs/LOCAL_SPEECH.md.
 *
 * `sherpa-onnx-node` is an OPTIONAL native dependency, imported only when a
 * local provider is first used, so a deployment that never selects `local`
 * neither needs it nor loads a model. Weights are loaded once per process
 * and inference runs off the event loop (the addon's async entry points).
 */

export class LocalSpeechConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalSpeechConfigError";
  }
}

export interface LocalSpeechEngine {
  /** BCP-47 tags the recognizer was validated for. */
  readonly sttLanguages: string[];
  /** Voice languages installed, as primary subtags (`te`, `en`). */
  readonly voiceLanguages: string[];
  readonly voiceIds: string[];
  transcribe(samples: Float32Array, sampleRate: number): Promise<string>;
  /**
   * Synthesize `text` with the voice for `language`. `onAudio` receives audio
   * a sentence at a time; returning false abandons the rest (cancellation).
   */
  synthesize(language: string, text: string, speed: number, onAudio: (samples: Float32Array, sampleRate: number) => boolean): Promise<void>;
  resample(samples: Float32Array, from: number, to: number): Float32Array;
}

const voice = z.object({ id: z.string(), model: z.string(), tokens: z.string(), sampleRate: z.int().positive() });
const manifestSchema = z.object({
  version: z.literal(1),
  stt: z.object({ engine: z.literal("sherpa-onnx"), type: z.literal("omnilingual-ctc"), id: z.string(), model: z.string(), tokens: z.string(),
    sampleRate: z.int().positive(), languages: z.array(z.string()).min(1) }),
  tts: z.object({ engine: z.literal("sherpa-onnx"), type: z.literal("vits-piper"), dataDir: z.string(), voices: z.record(z.string(), voice) }),
});
export type LocalSpeechManifest = z.infer<typeof manifestSchema>;

/** Reads and validates the manifest; every referenced file must exist. Fails closed. */
export function loadLocalSpeechManifest(modelDir: string): LocalSpeechManifest {
  const path = join(modelDir, "manifest.json");
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new LocalSpeechConfigError(`local speech manifest is unreadable: ${path}`); }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) throw new LocalSpeechConfigError("local speech manifest is invalid or names an unsupported model");
  const manifest = result.data;
  if (!Object.keys(manifest.tts.voices).length) throw new LocalSpeechConfigError("local speech manifest configures no TTS voice");
  const files = [manifest.stt.model, manifest.stt.tokens, ...Object.values(manifest.tts.voices).flatMap(v => [v.model, v.tokens])];
  for (const file of files) if (!existsSync(join(modelDir, file))) throw new LocalSpeechConfigError(`local speech model file is missing: ${file}`);
  const dataDir = join(modelDir, manifest.tts.dataDir);
  if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) throw new LocalSpeechConfigError("local speech phonemizer data directory is missing");
  return manifest;
}

// The text helpers moved to local-tts-text.ts with the rest of the TTS text pipeline.
export { splitClauses, splitScriptRuns, UnspeakableTextError } from "./local-tts-text";

/* eslint-disable @typescript-eslint/no-explicit-any -- the addon ships no type declarations */
class SherpaSpeechEngine implements LocalSpeechEngine {
  readonly sttLanguages: string[];
  readonly voiceLanguages: string[];
  readonly voiceIds: string[];
  private addon?: Promise<any>;
  private recognizer?: Promise<any>;
  private readonly voices = new Map<string, Promise<any>>();
  private readonly resamplers = new Map<string, any>();
  private addonSync: any;
  /** One inference at a time per model: the handles are not documented as re-entrant. */
  private sttQueue: Promise<unknown> = Promise.resolve();
  private ttsQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly modelDir: string, private readonly manifest: LocalSpeechManifest, private readonly threads: number) {
    this.sttLanguages = manifest.stt.languages;
    this.voiceLanguages = Object.keys(manifest.tts.voices).sort();
    this.voiceIds = Object.values(manifest.tts.voices).map(v => v.id);
  }

  private load(): Promise<any> {
    // A variable specifier keeps bundlers and the type checker away from an
    // optional native module that most deployments never install.
    const specifier = "sherpa-onnx-node";
    this.addon ??= import(specifier).then(module => (this.addonSync = module.default ?? module), () => {
      this.addon = undefined;
      throw new LocalSpeechConfigError("the local speech provider needs the optional dependency sherpa-onnx-node");
    });
    return this.addon;
  }

  private getRecognizer(): Promise<any> {
    this.recognizer ??= this.load().then(addon => addon.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: this.manifest.stt.sampleRate, featureDim: 80 },
      modelConfig: { omnilingual: { model: join(this.modelDir, this.manifest.stt.model) }, tokens: join(this.modelDir, this.manifest.stt.tokens),
        numThreads: this.threads, provider: "cpu", debug: 0 },
    }));
    return this.recognizer;
  }

  private getVoice(language: string): Promise<any> {
    const definition = this.manifest.tts.voices[language];
    if (!definition) return Promise.reject(new UnspeakableTextError(`no local voice for language ${language}`));
    let loaded = this.voices.get(language);
    if (!loaded) {
      loaded = this.load().then(addon => addon.OfflineTts.createAsync({
        model: { vits: { model: join(this.modelDir, definition.model), tokens: join(this.modelDir, definition.tokens), dataDir: join(this.modelDir, this.manifest.tts.dataDir) },
          numThreads: this.threads, provider: "cpu", debug: false },
        maxNumSentences: 1,
      }));
      this.voices.set(language, loaded);
    }
    return loaded;
  }

  transcribe(samples: Float32Array, sampleRate: number): Promise<string> {
    const run = async () => {
      const recognizer = await this.getRecognizer();
      const stream = recognizer.createStream();
      // Resampled here, not inside the recognizer, which logs to stderr for every utterance it resamples.
      stream.acceptWaveform({ sampleRate: this.manifest.stt.sampleRate, samples: this.resample(samples, sampleRate, this.manifest.stt.sampleRate) });
      const result = await recognizer.decodeAsync(stream);
      return String(result?.text ?? "").trim();
    };
    const next = this.sttQueue.then(run, run);
    this.sttQueue = next.catch(() => undefined);
    return next;
  }

  synthesize(language: string, text: string, speed: number, onAudio: (samples: Float32Array, sampleRate: number) => boolean): Promise<void> {
    const run = async () => {
      const tts = await this.getVoice(language);
      let wanted = true;
      // The addon reuses the callback's buffer between sentences: copy before handing out.
      await tts.generateAsync({ text, sid: 0, speed, onProgress: (info: { samples: Float32Array }) => (wanted = wanted && onAudio(Float32Array.from(info.samples), tts.sampleRate)) });
    };
    const next = this.ttsQueue.then(run, run);
    this.ttsQueue = next.catch(() => undefined);
    return next;
  }

  resample(samples: Float32Array, from: number, to: number): Float32Array {
    if (from === to) return samples;
    if (!this.addonSync) throw new LocalSpeechConfigError("local speech engine is not loaded");
    const key = `${from}:${to}`;
    let resampler = this.resamplers.get(key);
    if (!resampler) this.resamplers.set(key, (resampler = new this.addonSync.LinearResampler(from, to)));
    const out = resampler.flush(samples);
    resampler.reset();
    return out;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const engines = new Map<string, LocalSpeechEngine>();

/** The process-wide engine for a model directory. Validates the manifest now; loads weights on first use. */
export function getLocalSpeechEngine(modelDir: string, threads = 4): LocalSpeechEngine {
  if (!Number.isInteger(threads) || threads < 1 || threads > 64) throw new LocalSpeechConfigError("VOICE_LOCAL_THREADS must be an integer between 1 and 64");
  const directory = resolve(modelDir), key = `${directory}:${threads}`;
  let engine = engines.get(key);
  if (!engine) engines.set(key, (engine = new SherpaSpeechEngine(directory, loadLocalSpeechManifest(directory), threads)));
  return engine;
}

// G.711 μ-law, kept local: provider adapters do not import the voice package.
export function mulawToFloat(mulaw: Uint8Array): Float32Array {
  const out = new Float32Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    const byte = ~mulaw[i] & 0xff, magnitude = (((byte & 0x0f) << 3) + 0x84) << ((byte & 0x70) >> 4);
    out[i] = (byte & 0x80 ? 0x84 - magnitude : magnitude - 0x84) / 32768;
  }
  return out;
}
export function pcm16ToFloat(pcm: Uint8Array): Float32Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2)), out = new Float32Array(view.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2), view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return out;
}
export function floatToMulaw(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let sample = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
    const sign = sample < 0 ? 0x80 : 0;
    sample = Math.min(Math.abs(sample), 32635) + 0x84;
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
    out[i] = ~(sign | (exponent << 4) | ((sample >> (exponent + 3)) & 0x0f)) & 0xff;
  }
  return out;
}
