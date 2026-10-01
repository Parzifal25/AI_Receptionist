import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeAudio, WEB_AUDIO_FORMAT } from "@halo/voice/transcribe-audio";
import type { StreamingSttProvider } from "@halo/ports/streaming-stt-provider";
import { HaloSpeechProvider } from "../../widget/src/halo-speech-provider";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function provider(failure = false): StreamingSttProvider {
  return { name: "contract-stt", capabilities: () => ({ languages: [], formats: [WEB_AUDIO_FORMAT], interimResults: false, providerEndpointing: false, reportsConfidence: false }),
    open: vi.fn((_options, emit) => ({ write: vi.fn(), close: vi.fn(async () => {}), finalize: () => emit(failure ? { type: "error", code: "auth", message: "secret must not escape", retryable: false } : { type: "final", text: "sample transcript", utteranceId: "1", confidence: null, language: null }) })) };
}
describe("bounded web STT adapter", () => {
  it("delivers PCM bytes and only returns an actual provider final", async () => {
    vi.useFakeTimers(); const stt = provider();
    const result = transcribeAudio(stt, new Uint8Array(640), "te-IN", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toBe("sample transcript");
    expect(stt.open).toHaveBeenCalledWith(expect.objectContaining({ format: WEB_AUDIO_FORMAT, language: "te-IN" }), expect.any(Function));
  });
  it("rejects fake providers and malformed PCM", async () => {
    await expect(transcribeAudio({ ...provider(), name: "fake-stt" }, new Uint8Array(640), "te-IN", new AbortController().signal)).rejects.toThrow("stt_not_configured");
    await expect(transcribeAudio(provider(), new Uint8Array(3), "te-IN", new AbortController().signal)).rejects.toThrow("bad_audio");
  });
  it("sanitizes provider failures instead of manufacturing text", async () => {
    vi.useFakeTimers(); const result = expect(transcribeAudio(provider(true), new Uint8Array(640), "te-IN", new AbortController().signal)).rejects.toThrow("stt_auth");
    await vi.advanceTimersByTimeAsync(20); await result;
  });
  it("honors cancellation without opening a provider", async () => {
    const controller = new AbortController(); controller.abort(); const stt = provider();
    await expect(transcribeAudio(stt, new Uint8Array(640), "te-IN", controller.signal)).rejects.toThrow("aborted");
    expect(stt.open).not.toHaveBeenCalled();
  });
});
describe("browser capture selection and permission failures", () => {
  it("supports microphone capture without Web Speech API and rejects insecure origins", () => {
    vi.stubGlobal("window", { isSecureContext: true, AudioContext: class {} });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });
    const speech = new HaloSpeechProvider(vi.fn());
    expect(speech.isRecognitionSupported()).toBe(true);
    window.isSecureContext = false;
    expect(speech.isRecognitionSupported()).toBe(false);
  });
  it("reports denied microphone access without invoking browser recognition or STT", async () => {
    const browserRecognition = vi.fn(), transcribe = vi.fn(), onError = vi.fn();
    vi.stubGlobal("window", { SpeechRecognition: browserRecognition });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")) } });
    new HaloSpeechProvider(transcribe).startRecognition("te-IN", { onError, onEnd: vi.fn(), onResult: vi.fn() });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("not-allowed"));
    expect(browserRecognition).not.toHaveBeenCalled(); expect(transcribe).not.toHaveBeenCalled();
  });
});

describe("web microphone PCM boundary", () => {
  it("resamples captured hardware audio and sends little-endian PCM, never browser recognition", async () => {
    const transcribe = vi.fn(async (_audio: string, _signal: AbortSignal) => "provider words"), onResult = vi.fn(), onError = vi.fn();
    const stop = vi.fn(); let process: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | undefined;
    class CaptureContext {
      sampleRate = 48000; state = "running"; destination = {};
      resume = async () => {}; close = async () => { this.state = "closed"; };
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
      createScriptProcessor = () => ({ set onaudioprocess(callback: typeof process) { process = callback; }, connect: vi.fn(), disconnect: vi.fn() });
    }
    const resample = vi.fn();
    class Resampler {
      destination = {};
      constructor(channels: number, length: number, rate: number) { resample(channels, length, rate); }
      createBuffer = () => ({ copyToChannel: vi.fn() });
      createBufferSource = () => ({ buffer: null, connect: vi.fn(), start: vi.fn() });
      startRendering = async () => ({ getChannelData: () => new Float32Array([1, -1, 0]) });
    }
    vi.stubGlobal("AudioContext", CaptureContext); vi.stubGlobal("OfflineAudioContext", Resampler);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) } });
    new HaloSpeechProvider(transcribe).startRecognition("te-IN", { onResult, onError, onEnd: vi.fn() });
    await vi.waitFor(() => expect(process).toBeDefined());
    process!({ inputBuffer: { getChannelData: () => new Float32Array(48000).fill(0.2) } });
    process!({ inputBuffer: { getChannelData: () => new Float32Array(48000) } });
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith("provider words", true));
    expect(resample).toHaveBeenCalledWith(1, 32000, 16000);
    expect(Buffer.from(transcribe.mock.calls[0][0], "base64")).toEqual(Buffer.from([255, 127, 1, 128, 0, 0]));
    expect(stop).toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
  });
});
