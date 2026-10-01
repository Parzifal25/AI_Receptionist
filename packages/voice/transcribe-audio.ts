import type { StreamingSttProvider, SttStream } from "@halo/ports/streaming-stt-provider";

export const WEB_AUDIO_FORMAT = { encoding: "pcm16le", sampleRate: 16000, channels: 1 } as const;
/** Bounded web utterance through the same provider port as phone STT. */
export async function transcribeAudio(provider: StreamingSttProvider, audio: Uint8Array, language: string, signal: AbortSignal): Promise<string> {
  if (provider.name.includes("fake")) throw new Error("stt_not_configured");
  if (!audio.length || audio.length % 2 || audio.length > 32000 * 10) throw new Error("bad_audio");
  if (!provider.capabilities().formats.some(f => f.encoding === "pcm16le" && f.sampleRate === 16000 && f.channels === 1)) throw new Error("bad_audio");
  const languages = provider.capabilities().languages;
  const selectedLanguage = languages.includes(language) || !languages.length ? language : languages.find(value => value.split("-")[0] === language.split("-")[0]);
  if (!selectedLanguage) throw new Error("stt_unsupported_language");
  let stream: SttStream | undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pacing: ReturnType<typeof setInterval> | undefined;
  let abort: () => void = () => {};
  try {
    return await new Promise<string>((resolve, reject) => {
      const finish = (text?: string, error?: string) => {
        if (settled) return;
        settled = true;
        if (error) reject(new Error(error)); else resolve(text!);
      };
      abort = () => finish(undefined, "aborted");
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      timer = setTimeout(() => finish(undefined, "stt_timeout"), 25000);
      stream = provider.open({ language: selectedLanguage, alternativeLanguages: [], format: WEB_AUDIO_FORMAT, interimResults: false, phraseHints: [] }, event => {
        if (event.type === "final" && event.text.trim()) finish(event.text.trim());
        if (event.type === "error") finish(undefined, `stt_${event.code}`);
        if (event.type === "closed") finish(undefined, "stt_closed");
      });
      // Stream at audio cadence. Dumping a whole recording while a vendor socket
      // is connecting would overflow the existing bounded startup buffer.
      let offset = 0;
      pacing = setInterval(() => {
        if (settled) return;
        try {
          stream!.write(audio.subarray(offset, offset + 640)); offset += 640;
          if (offset >= audio.length) { clearInterval(pacing); stream!.finalize(); }
        } catch { finish(undefined, "stt_provider"); }
      }, 20);
    });
  } finally {
    clearTimeout(timer); clearInterval(pacing);
    signal.removeEventListener("abort", abort);
    await stream?.close();
  }
}
