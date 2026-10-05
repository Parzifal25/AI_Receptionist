import type { SpeechProvider } from "@halo/ports/speech-provider";
import type { SpeechRecognitionCallbacks, SpeechRecognitionSession } from "@halo/ports/speech-provider";

/** Server STT/TTS through HALO. Web Audio captures and plays PCM; no Web Speech API. */
export class HaloSpeechProvider implements SpeechProvider {
  readonly name = "halo-web";
  private playback?: AudioContext;
  private playbackAbort?: AbortController;
  constructor(
    private readonly transcribe: (audio: string, signal: AbortSignal) => Promise<string>,
    private readonly synthesize?: (signal: AbortSignal) => Promise<{ audio: string; format: { encoding: string; sampleRate: number; channels: number } }>,
    private readonly onPlaybackError: () => void = () => {},
  ) {}
  isSynthesisSupported(): boolean { return !!this.synthesize && typeof AudioContext !== "undefined"; }
  cancelSpeech(): void {
    this.playbackAbort?.abort(); this.playbackAbort = undefined;
    if (this.playback && this.playback.state !== "closed") void this.playback.close().catch(() => {});
    this.playback = undefined;
  }
  speak(_text: string, _language: string, onEnd?: () => void): void {
    this.cancelSpeech();
    const abort = new AbortController(); this.playbackAbort = abort;
    void (async () => {
      if (!this.synthesize) throw new Error("tts_not_configured");
      const result = await this.synthesize(abort.signal);
      if (abort.signal.aborted) return;
      const { format } = result;
      if (format.encoding !== "pcm16le" || format.channels !== 1 || ![8000, 16000, 22050, 24000].includes(format.sampleRate)) throw new Error("bad_audio");
      const binary = atob(result.audio);
      if (!binary.length || binary.length % 2) throw new Error("bad_audio");
      const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      const view = new DataView(bytes.buffer);
      const context = new AudioContext(); this.playback = context;
      await context.resume();
      if (abort.signal.aborted) return;
      if (context.state !== "running") throw new Error("playback_blocked");
      const buffer = context.createBuffer(1, bytes.length / 2, format.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
      source.onended = () => { if (!abort.signal.aborted) { this.cancelSpeech(); onEnd?.(); } };
      source.start();
    })().catch(() => { if (!abort.signal.aborted) { this.cancelSpeech(); this.onPlaybackError(); } });
  }
  isRecognitionSupported(): boolean {
    return typeof window !== "undefined" && window.isSecureContext !== false && !!navigator.mediaDevices?.getUserMedia && !!window.AudioContext;
  }
  startRecognition(_language: string, callbacks: SpeechRecognitionCallbacks): SpeechRecognitionSession {
    let stopped = false, stream: MediaStream | undefined, context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined, processor: ScriptProcessorNode | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const cleanup = () => { clearTimeout(timer); processor?.disconnect(); source?.disconnect(); stream?.getTracks().forEach(t => t.stop()); if (context && context.state !== "closed") void context.close().catch(() => {}); };
    void Promise.resolve().then(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
        if (stopped) { cleanup(); return; }
        context = new AudioContext(); await context.resume();
        if (context.state !== "running") throw new Error("audio-capture");
        if (stopped) { cleanup(); return; }
        const inputRate = context.sampleRate;
        const chunks: Float32Array[] = []; let count = 0, lastSpeech = 0, heardSpeech = false, finishing = false;
        const finish = async () => {
          if (finishing || stopped) return; finishing = true; cleanup();
          if (!heardSpeech || !count) { callbacks.onEnd(); return; }
          const samples = new Float32Array(count); let offset = 0;
          for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
          // Web Audio resampling applies filtering; never label 44.1/48 kHz
          // hardware samples as 16 kHz or send WebM/Opus as raw PCM.
          const offline = new OfflineAudioContext(1, Math.ceil(count * 16000 / inputRate), 16000);
          const buffer = offline.createBuffer(1, count, inputRate); buffer.copyToChannel(samples, 0);
          const input = offline.createBufferSource(); input.buffer = buffer; input.connect(offline.destination); input.start();
          const rendered = (await offline.startRendering()).getChannelData(0);
          const bytes = new Uint8Array(rendered.length * 2), view = new DataView(bytes.buffer);
          for (let i = 0; i < rendered.length; i++) view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, rendered[i])) * 32767), true);
          let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
          const text = await this.transcribe(btoa(binary), abort.signal);
          if (!stopped) { callbacks.onResult(text, true); callbacks.onEnd(); }
        };
        source = context.createMediaStreamSource(stream); processor = context.createScriptProcessor(2048, 1, 1);
        processor.onaudioprocess = event => {
          if (stopped || finishing) return;
          const data = event.inputBuffer.getChannelData(0).slice(); chunks.push(data); count += data.length;
          const rms = Math.sqrt(data.reduce((sum, x) => sum + x * x, 0) / data.length);
          if (rms > 0.01) { heardSpeech = true; lastSpeech = count; }
          if ((heardSpeech && (count - lastSpeech) / inputRate > 0.9) || count / inputRate >= 8) void finish().catch(fail);
        };
        source.connect(processor); processor.connect(context.destination); // output remains silence
        timer = setTimeout(() => void finish().catch(fail), 8500);
      } catch (error) { fail(error); }
    });
    const fail = (error: unknown) => {
      cleanup(); if (stopped) return;
      const name = error instanceof Error ? error.name : "";
      const code = name === "NotAllowedError" || name === "SecurityError" ? "not-allowed" :
        ["NotFoundError", "NotReadableError", "OverconstrainedError"].includes(name) ? "audio-capture" : "halo-unavailable";
      console.warn("HALO microphone/STT failure", { code }); // no audio, transcript, URL or credentials
      callbacks.onError(code);
    };
    return { stop: () => { stopped = true; abort.abort(); cleanup(); } };
  }
}
