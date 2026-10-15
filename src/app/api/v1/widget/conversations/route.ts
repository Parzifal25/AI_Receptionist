import { bindSecurityIdentity } from "@halo/platform/security-audit";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@halo/core/errors/app-error";
import { WidgetRepository } from "@/core/services/widget-repository";
import { AgentResolver, resolutionFailureReason } from "@halo/agents/agent-resolver";
import { SupabaseAgentRepository } from "@halo/agents/agent-repository";
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
 * Fail closed: a conversation without agent linkage cannot be served by the
 * agent runtime, so all resolution failures return 503 instead of creating
 * an unattributed row. The public widget request and success envelope stay
 * unchanged; identity is resolved only from the tenant-bound widget key.
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
  await bindSecurityIdentity({ actorId: null, businessId: business.id });

  if (!isOriginAllowed(origin, allowedDomains)) {
    return fail(AppError.forbidden("This domain is not allowed to embed this widget"), headers);
  }

  // Resolution chain: widget_key → receptionist (tenant proof) → agent
  // (slug = receptionist id, seeded by 0014) → published live version.
  // All steps are tenant-scoped; a widget key can only ever resolve agents
  // of its own tenant.
  const resolver = new AgentResolver({ agentRepository: new SupabaseAgentRepository() });
  let agentId: string;
  let agentVersionId: string;
  try {
    // Resolve against the exact tenant/receptionist context established by
    // the first widget-key lookup. A second key lookup could observe a
    // concurrent remap and pair another tenant's agent with this receptionist.
    const resolved = await resolver.resolveForAgentSlug(business.id, receptionist.id);
    if (
      receptionist.businessId !== business.id ||
      resolved.businessId !== business.id ||
      resolved.agent.businessId !== business.id ||
      resolved.version.businessId !== business.id ||
      resolved.version.agentId !== resolved.agent.id
    ) {
      throw AppError.forbidden("Resolved widget identity is inconsistent");
    }
    agentId = resolved.agent.id;
    agentVersionId = resolved.version.id;
  } catch (error) {
    const reason = resolutionFailureReason(error);
    // No conversation row is created without trustworthy pinned identity.
    // Resolver/store failures are logged server-side and returned opaquely.
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
