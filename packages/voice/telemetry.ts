import { observe } from "@halo/platform/telemetry";

/** Map existing events to fixed operational labels; never forward event detail. */
export function observeVoiceEvent(
  id: string, type: string, latencyMs: number | null,
  detail: Record<string, unknown>, engine: "node" | "pipecat",
  providers?: { stt: string; tts: string },
): void {
  if (type === "session_started" || type === "session_ended") {
    observe("voice.session", { component: "voice", engine, reason: detail.reason,
      outcome: type === "session_started" ? "started" : "completed" }, undefined, id);
    return;
  }
  if (type === "provider_error") {
    const operation = detail.component === "stt" ? "stt" : detail.component === "tts" ? "tts" : undefined;
    observe("voice.failure", { component: "voice", engine, operation,
      provider: operation ? providers?.[operation] : undefined, outcome: "error" }, latencyMs ?? undefined, id);
    return;
  }
  if (type === "stt_final" || type === "tts_complete") {
    const operation = type === "stt_final" ? "stt" : "tts";
    observe(`voice.${operation}`, { component: "voice", engine, operation,
      phase: operation === "stt" ? "endpoint" : "playback",
      provider: providers?.[operation], outcome: "ok" }, latencyMs ?? undefined, id);
  }
}
