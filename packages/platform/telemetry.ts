import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const context = new AsyncLocalStorage<string>();
export const newTelemetryId = () => randomUUID();
export function withTelemetryContext<T>(fn: () => T, id = context.getStore() ?? newTelemetryId()): T {
  return context.run(id, fn);
}
export function telemetryId(): string | undefined { return context.getStore(); }

// Values as well as keys are allowlisted. Never accept URLs, error messages,
// tool arguments, model names, tenant configuration or caller supplied IDs.
const values: Record<string, readonly string[]> = {
  engine: ["node", "pipecat", "web"],
  phase: ["endpoint", "playback", "upload", "synthesis"],
  route: ["health", "widget", "appointments", "workflows", "cron", "campaigns", "learning", "analytics", "admin", "hooks", "other"],
  reason: ["caller_hangup", "agent_completed", "silence_timeout", "transferred", "media_disconnected", "stt_failure", "tts_failure", "agent_failure", "provider_status", "max_duration", "gateway_shutdown", "rejected"],
  component: ["api", "gateway", "voice", "runtime", "dependency", "booking"],
  operation: ["request", "attempt", "retry", "stt", "tts", "fallback", "state", "tool", "booking"],
  provider: ["sarvam", "local", "fake", "google", "other", "sarvam-stt", "sarvam-tts", "local-stt", "local-tts", "fallback-stt", "fallback-tts", "fake-stt", "fake-tts"],
  outcome: ["ok", "error", "timeout", "cancelled", "rejected", "started", "completed", "failed", "pending", "confirmed", "conflict"],
  state: ["idle", "listening", "thinking", "speaking", "user_speaking", "transferring", "ending", "ended"],
};
export type TelemetryFields = Record<string, unknown>;
export interface Observation {
  schema: 1; time: string; event: string; correlationId: string;
  labels: Record<string, string | number>; count: 1; durationMs?: number;
}
/** Opt-in local stdout only. Unknown exporter configuration fails closed. */
export function telemetryStatus() {
  return { enabled: process.env.HALO_TELEMETRY === "stdout", exporter: process.env.HALO_TELEMETRY === "stdout" ? "stdout" : "disabled" };
}
export function observe(event: string, fields: TelemetryFields = {}, durationMs?: number, id?: string): void {
  if (!telemetryStatus().enabled) return;
  try {
    const labels: Observation["labels"] = {};
    for (const [key, allowed] of Object.entries(values)) {
      if (typeof fields[key] === "string" && allowed.includes(fields[key] as string)) labels[key] = fields[key] as string;
    }
    if (Number.isInteger(fields.status) && Number(fields.status) >= 100 && Number(fields.status) <= 599) labels.status = Number(fields.status);
    // Event names come from static instrumentation, but enforce a bounded set
    // at runtime too, including when JS callers bypass TypeScript.
    if (!["http.request", "dependency.attempt", "dependency.retry", "voice.stt", "voice.tts", "voice.fallback", "voice.state", "voice.audio", "voice.processing", "voice.failure", "voice.session", "runtime.outcome", "tool.outcome", "booking.outcome"].includes(event)) return;
    const candidate = id ?? context.getStore();
    const correlationId = candidate && /^[a-f0-9-]{36}$/.test(candidate) ? candidate : newTelemetryId();
    const record: Observation = { schema: 1, time: new Date().toISOString(), event, correlationId, labels, count: 1 };
    if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) record.durationMs = Math.round(durationMs * 1000) / 1000;
    console.log(JSON.stringify({ telemetry: record }));
  } catch { /* Logging/export failures must never affect application behavior. */ }
}
export function errorOutcome(error: unknown): "timeout" | "cancelled" | "error" {
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return "error";
}
