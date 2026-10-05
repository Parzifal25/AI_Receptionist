import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { signWebTts } from "@halo/voice/web-audio-auth";
import { TtsError, type StreamingTtsProvider } from "@halo/ports/streaming-tts-provider";
import { logger } from "@halo/platform/logger";

const schema = z.object({ businessId: z.string().uuid(), language: z.string().min(2).max(20), text: z.string().trim().min(1).max(4000), timestamp: z.number() }).strict();

/** Same authenticated gateway and provider port as STT; no client-selected tenant or voice. */
export async function handleWebTts(req: IncomingMessage, res: ServerResponse, secret: string, sampleRate: number, provider?: StreamingTtsProvider): Promise<void> {
  const send = (status: number, data: object) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 32000) { send(413, { error: "bad_text" }); return; } chunks.push(Buffer.from(chunk)); }
  const body = Buffer.concat(chunks).toString("utf8");
  const signature = req.headers["x-halo-signature"], expected = signWebTts(secret, body);
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) { send(403, { error: "unauthorized" }); return; }
  const parsed = schema.safeParse((() => { try { return JSON.parse(body); } catch { return null; } })());
  if (!parsed.success || Math.abs(Date.now() - parsed.data.timestamp) > 30000) { send(400, { error: "bad_text" }); return; }
  if (!provider || provider.name.includes("fake")) { send(503, { error: "tts_not_configured" }); return; }
  const format = provider.capabilities().formats.find(f => f.encoding === "pcm16le" && f.channels === 1 && f.sampleRate === sampleRate);
  const languages = provider.capabilities().languages;
  const language = languages.find(l => l === parsed.data.language) ?? languages.find(l => l.split("-")[0] === parsed.data.language.split("-")[0]);
  if (!format || (languages.length && !language)) { send(400, { error: "tts_unsupported_format_or_language" }); return; }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 25000);
  const onClose = () => { if (!res.writableEnded) abort.abort(); }; res.on("close", onClose);
  const started = Date.now(); let firstAudioMs: number | undefined;
  try {
    const audio: Buffer[] = []; let bytes = 0;
    for await (const chunk of provider.synthesize({ text: parsed.data.text, language: language ?? parsed.data.language, format }, abort.signal)) {
      firstAudioMs ??= Date.now() - started;
      bytes += chunk.length;
      if (bytes > sampleRate * 2 * 120) throw new Error("audio_limit");
      audio.push(Buffer.from(chunk));
    }
    if (abort.signal.aborted || !bytes || bytes % 2) throw new Error("incomplete_audio");
    logger.info("web TTS completed", { provider: provider.name, firstAudioMs, latencyMs: Date.now() - started, bytes, sampleRate });
    send(200, { audio: Buffer.concat(audio).toString("base64"), format, provider: provider.name });
  } catch (error) {
    const code = error instanceof TtsError ? error.code : "provider";
    logger.warn("web TTS failed", { provider: provider.name, code });
    if (!res.destroyed) send(502, { error: `tts_${code}` });
  } finally { clearTimeout(timer); res.off("close", onClose); }
}
