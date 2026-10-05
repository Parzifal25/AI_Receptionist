import { afterEach, expect, it, vi } from "vitest";
import { HaloSpeechProvider } from "../../widget/src/halo-speech-provider";
afterEach(() => vi.unstubAllGlobals());
it("decodes provider PCM at its declared rate and resumes only after playback ends", async () => {
 let ended: (() => void) | undefined; const start = vi.fn(); const samples = new Float32Array(2); const createBuffer = vi.fn(() => ({ getChannelData: () => samples }));
 class Context {
  state = "running"; destination = {}; resume = async () => {}; close = async () => { this.state = "closed"; };
  createBuffer = createBuffer;
  createBufferSource = () => ({ connect: vi.fn(), start, buffer: null, set onended(callback: () => void) { ended = callback; } });
 }
 vi.stubGlobal("AudioContext", Context);
 const onEnd = vi.fn(); const error = vi.fn();
 const speech = new HaloSpeechProvider(vi.fn(), async () => ({ audio: Buffer.from([0, 128, 255, 127]).toString("base64"), format: { encoding: "pcm16le", sampleRate: 24000, channels: 1 } }), error);
 speech.speak("HALO reply", "te-IN", onEnd);
 await vi.waitFor(() => expect(start).toHaveBeenCalled());
 expect(createBuffer).toHaveBeenCalledWith(1, 2, 24000); expect([...samples]).toEqual([-1, 32767 / 32768]); expect(onEnd).not.toHaveBeenCalled();
 ended!(); expect(onEnd).toHaveBeenCalledOnce(); expect(error).not.toHaveBeenCalled();
});
it("cancels pending synthesis and ignores its late response", async () => {
 let complete!: (result: { audio: string; format: { encoding: string; sampleRate: number; channels: number } }) => void;
 const context = vi.fn(); vi.stubGlobal("AudioContext", context);
 const onEnd = vi.fn(), onError = vi.fn();
 const speech = new HaloSpeechProvider(vi.fn(), () => new Promise(resolve => { complete = resolve; }), onError);
 speech.speak("reply", "en", onEnd); speech.cancelSpeech();
 complete({ audio: "AAAA", format: { encoding: "pcm16le", sampleRate: 16000, channels: 1 } });
 await Promise.resolve(); expect(context).not.toHaveBeenCalled(); expect(onEnd).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
});
it("reports synthesis failure without invoking success or browser speech", async () => {
 const error = vi.fn(), onEnd = vi.fn();
 const speech = new HaloSpeechProvider(vi.fn(), async () => { throw new Error("provider unavailable"); }, error);
 speech.speak("reply", "en", onEnd);
 await vi.waitFor(() => expect(error).toHaveBeenCalledOnce()); expect(onEnd).not.toHaveBeenCalled();
});
