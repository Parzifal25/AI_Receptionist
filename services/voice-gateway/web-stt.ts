import { withSecurityAudit, bindSecurityIdentity, finishSecurityAudit, SecurityAuditUnavailable } from "@halo/platform/security-audit";
import { securityAuditStore } from "@halo/tenancy/security-audit-store";
import { withTelemetryContext, telemetryId } from "@halo/platform/telemetry";
import { signWebAudio } from "@halo/voice/web-audio-auth";
export { signWebAudio } from "@halo/voice/web-audio-auth";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StreamingSttProvider } from "@halo/ports/streaming-stt-provider";
import { transcribeAudio } from "@halo/voice/transcribe-audio";
import { logger } from "@halo/platform/logger";
const schema = z.object({ correlationId: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).optional(), businessId: z.string().uuid(), language: z.string().min(2).max(20), audio: z.string().min(4).max(426668).regex(/^[A-Za-z0-9+/]+={0,2}$/), timestamp: z.number() }).strict();
export async function handleWebStt(req: IncomingMessage, res: ServerResponse, secret: string, provider?: StreamingSttProvider): Promise<void> {
  let auditStatus = 500;
  const send = (status: number, data: object) => { auditStatus = status; res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 430000) { send(413, { error: "bad_audio" }); return; } chunks.push(Buffer.from(chunk)); }
  const body = Buffer.concat(chunks).toString("utf8");
  const signature = req.headers["x-halo-signature"];
  const expected = signWebAudio(secret, body);
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) { await withSecurityAudit(securityAuditStore, false, () => finishSecurityAudit(403), "POST", "widget"); send(403, { error: "unauthorized" }); return; }
  const parsed = schema.safeParse((() => { try { return JSON.parse(body); } catch { return null; } })());
  if (!parsed.success || Math.abs(Date.now() - parsed.data.timestamp) > 30000) { send(400, { error: "bad_audio" }); return; }
  logger.info("gateway correlation accepted", { upstreamCorrelationId: parsed.data.correlationId, requestId: telemetryId() });
  return withTelemetryContext(() => withSecurityAudit(securityAuditStore, true, async () => {
  try {
    await bindSecurityIdentity({ actorId: null, businessId: parsed.data.businessId });
  if (!provider || provider.name.includes("fake")) { send(503, { error: "stt_not_configured" }); return; }
  const abort = new AbortController();
  const onClose = () => { if (!res.writableEnded) abort.abort(); };
  res.on("close", onClose);
  try {
    const started = Date.now();
    const text = await transcribeAudio(provider, Buffer.from(parsed.data.audio, "base64"), parsed.data.language, abort.signal);
    logger.info("web STT completed", { provider: provider.name, latencyMs: Date.now() - started });
    send(200, { text, provider: provider.name });
  } catch (error) {
    const code = error instanceof Error && /^(stt_[a-z_]+|bad_audio|aborted)$/.test(error.message) ? error.message : "stt_provider";
    logger.warn("web STT failed", { provider: provider.name, code });
    if (!res.destroyed) send(502, { error: code });
  } finally { res.off("close", onClose); }
  } catch (error) {
    if (error instanceof SecurityAuditUnavailable) { send(503, { error: "audit_unavailable" }); return; }
    throw error;
  } finally { await finishSecurityAudit(auditStatus); }
  }, "POST", "widget"), parsed.data.correlationId ?? telemetryId());
}
