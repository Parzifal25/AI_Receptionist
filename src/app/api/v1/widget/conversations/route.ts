import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@halo/core/errors/app-error";
import { WidgetRepository } from "@/core/services/widget-repository";
import { AgentResolver, resolutionFailureReason } from "@halo/agents/agent-resolver";
import { SupabaseAgentRepository } from "@halo/agents/agent-repository";
import { getServerEnv } from "@halo/platform/env";
import { corsHeaders, isOriginAllowed, preflightResponse } from "@/lib/api/cors";
import { clientIp, fail, withErrorHandling } from "@/lib/api/respond";
import { widgetSessionLimiter } from "@halo/platform/rate-limit";
import { emitBusinessEvent } from "@halo/workflows/event-bus";
import { logger } from "@halo/platform/logger";

const log = logger.child({ route: "widget.conversations" });

const bodySchema = z.object({
  widgetKey: z.string().min(8).max(64),
  channel: z.enum(["chat", "voice"]).default("chat"),
  pageUrl: z.string().max(2000).default(""),
});

export const OPTIONS = (request: NextRequest) =>
  preflightResponse(request.headers.get("origin"));

/**
 * Temporary compatibility exception (Phase 1.5, workstream 5): only the
 * pre-0014 "no agent backfilled yet" signature may start an unattributed
 * conversation, and only when explicitly enabled. Defaults to closed, so an
 * invalid/invalidated environment fails closed too. Removal is tracked with
 * the Phase 2 agent-console work (which will backfill agents at creation).
 */
function agentResolutionCompatFailOpen(): boolean {
  try {
    return getServerEnv().HALO_AGENT_RESOLUTION_COMPAT_FAIL_OPEN;
  } catch {
    return false;
  }
}

/**
 * POST /api/v1/widget/conversations
 * Starts a conversation. Returns a visitor token the browser holds as its
 * proof of conversation ownership — no Supabase credentials ever reach the
 * visitor.
 *
 * HALO Phase 1 (plan §P1.3): the agent and the exact published agent version
 * serving the conversation are resolved on the SERVER from the widget key's
 * tenant and persisted on the conversation row. The client supplies only the
 * widget key; agent/version identity is never accepted from the request.
 *
 * Phase 1.5 (workstream 5) — fail closed: a conversation without agent
 * linkage cannot be served by the agent runtime, so resolution failures
 * return 503 instead of creating an unattributed row. The single exception
 * is the pre-backfill signature (agent_not_found for a tenant onboarded
 * before migration 0014) gated behind HALO_AGENT_RESOLUTION_COMPAT_FAIL_OPEN,
 * logged with a reason classification and scoped to removal in Phase 2.
 */
export const POST = withErrorHandling("widget.conversations", async (request: NextRequest) => {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);

  const rate = await widgetSessionLimiter.check(`session:${clientIp(request)}`);
  if (!rate.allowed) return fail(AppError.rateLimited(), headers);

  const body = bodySchema.parse(await request.json().catch(() => ({})));

  const repository = new WidgetRepository();
  const { receptionist, business, allowedDomains } =
    await repository.getReceptionistByWidgetKey(body.widgetKey);

  if (!isOriginAllowed(origin, allowedDomains)) {
    return fail(AppError.forbidden("This domain is not allowed to embed this widget"), headers);
  }

  // Resolution chain: widget_key → receptionist (tenant proof) → agent
  // (slug = receptionist id, seeded by 0014) → published live version.
  // All steps are tenant-scoped; a widget key can only ever resolve agents
  // of its own tenant.
  const resolver = new AgentResolver({
    agentRepository: new SupabaseAgentRepository(),
    tenantResolver: async (key) => {
      // Re-fetch through the same tenant-proof path (widget key →
      // receptionist row); the agent slug is the receptionist id, so the
      // mapping is deterministic and tenant-owned.
      const ctx = await repository.getReceptionistByWidgetKey(key);
      return { businessId: ctx.business.id, agentSlug: ctx.receptionist.id };
    },
  });
  let agentId: string | null;
  let agentVersionId: string | null;
  try {
    const resolved = await resolver.resolveForWidgetKey(body.widgetKey);
    agentId = resolved.agent.id;
    agentVersionId = resolved.version.id;
  } catch (error) {
    const reason = resolutionFailureReason(error);
    if (!(reason === "agent_not_found" && agentResolutionCompatFailOpen())) {
      // Fail closed: no conversation row without trustworthy attribution.
      // Unclassified failures (store outages, unexpected errors) land here
      // too — they are never eligible for the compatibility path.
      log.error("agent resolution failed; refusing unattributed conversation", {
        reason: reason ?? "unclassified",
        widgetKeyPrefix: body.widgetKey.slice(0, 4),
        error,
      });
      return fail(
        AppError.serviceUnavailable("Chat is temporarily unavailable — please try again shortly"),
        headers,
      );
    }
    // Narrowly-scoped compatibility path: pre-backfill tenant, explicitly
    // enabled, logged with its reason so it stays observable and auditable.
    log.warn("agent resolution failed; compat fail-open conversation without agent linkage", {
      reason,
      widgetKeyPrefix: body.widgetKey.slice(0, 4),
      error,
    });
    agentId = null;
    agentVersionId = null;
  }

  const conversation = await repository.createConversation({
    businessId: business.id,
    receptionistId: receptionist.id,
    agentId,
    agentVersionId,
    channel: body.channel,
    pageUrl: body.pageUrl,
    userAgent: request.headers.get("user-agent") ?? "",
  });

  await repository.trackEvent(business.id, "conversation_started", {
    channel: body.channel,
  });
  if (body.channel === "voice") {
    await repository.trackEvent(business.id, "voice_used");
  }
  // Workflow trigger — fire-and-forget, never delays the visitor.
  void emitBusinessEvent({
    businessId: business.id,
    type: "conversation.started",
    correlationId: conversation.id,
    payload: { conversationId: conversation.id, channel: body.channel, pageUrl: body.pageUrl },
  }).catch((error) => log.warn("business event emit failed", { error }));

  return NextResponse.json(
    {
      data: {
        visitorToken: conversation.visitorToken,
        greeting: receptionist.greeting,
      },
    },
    { status: 201, headers },
  );
});
