/** Live provider acceptance. Run with .env.local; never prints credentials. */
import { writeFileSync } from "node:fs";
import { loadGatewayConfig } from "../services/voice-gateway/config";
import { createTtsProvider } from "@halo/providers/voice-vendors/factory";
import { signWebAudio, signWebTts } from "@halo/voice/web-audio-auth";

async function main() {
  const config = loadGatewayConfig();
  if (config.sttProvider !== "sarvam" || config.ttsProvider !== "sarvam") throw new Error("Live smoke requires Sarvam STT and TTS");
  const base = process.env.VOICE_GATEWAY_INTERNAL_URL;
  if (!base) throw new Error("Gateway URL required");
  const tts = createTtsProvider({ provider: config.ttsProvider, apiKey: config.ttsApiKey, defaultSpeaker: config.ttsDefaultVoice, model: config.ttsModel });
  // This is a synthesized speech sample, NOT evidence of a physical microphone.
  const samples = [
    { language: "en-IN", text: "Hello, how can I help you today?", name: "english" },
    { language: "te-IN", text: "నమస్కారం, నాకు సోలార్ గురించి తెలుసుకోవాలి.", name: "telugu" },
    { language: "te-IN", text: "Naaku solar installation gurinchi details kavali.", name: "tenglish" },
  ];
  for (const sample of samples) {
    const started = Date.now(); const chunks: Buffer[] = [];
    for await (const chunk of tts.synthesize({ text: sample.text, language: sample.language, format: { encoding: "pcm16le", sampleRate: 16000, channels: 1 } }, AbortSignal.timeout(25000))) chunks.push(Buffer.from(chunk));
    const audio = Buffer.concat(chunks);
    if (!audio.length) throw new Error("No provider audio");
    const header = Buffer.alloc(44); header.write("RIFF"); header.writeUInt32LE(36 + audio.length, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(audio.length, 40);
    writeFileSync(`/tmp/halo-${sample.name}.wav`, Buffer.concat([header, audio]));
    console.log(JSON.stringify({ stage: "tts", sample: sample.name, bytes: audio.length, latencyMs: Date.now() - started }));
    const body = JSON.stringify({ businessId: "11111111-1111-4111-8111-111111111111", language: sample.language, audio: audio.toString("base64"), timestamp: Date.now() });
    const sttStart = Date.now();
    const response = await fetch(new URL("/web/stt", base), { method: "POST", headers: { "x-halo-signature": signWebAudio(config.streamTokenSecret, body) }, body, signal: AbortSignal.timeout(30000) });
    console.log(JSON.stringify({ stage: "stt", sample: sample.name, status: response.status, result: await response.json(), latencyMs: Date.now() - sttStart }));
    if (!response.ok) throw new Error("Gateway STT failed");
    const ttsBody = JSON.stringify({ businessId: "11111111-1111-4111-8111-111111111111", language: sample.language, text: sample.name === "telugu" ? "నమస్కారం, నేను మీకు ఎలా సహాయం చేయగలను?" : sample.text, timestamp: Date.now() });
    const synthesized = await fetch(new URL("/web/tts", base), { method: "POST", headers: { "x-halo-signature": signWebTts(config.streamTokenSecret, ttsBody) }, body: ttsBody, signal: AbortSignal.timeout(30000) });
    const result = await synthesized.json();
    console.log(JSON.stringify({ stage: "gateway-tts", status: synthesized.status, sample: sample.name, bytes: result.audio ? Buffer.from(result.audio, "base64").length : 0, format: result.format, error: result.error }));
    if (!synthesized.ok) throw new Error("Gateway TTS failed");
  }
}
void main().catch(error => { console.error(JSON.stringify({ error: error instanceof Error ? error.message.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]").slice(0, 200) : "smoke failed" })); process.exitCode = 1; });
