import { bindSecurityIdentity } from "@halo/platform/security-audit";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@halo/core/errors/app-error";
import { ChatService, type ResolvedAgentRuntimeContext } from "@/core/services/chat-service";
import { SupabaseAgentRepository } from "@halo/agents/agent-repository";
import { BookingOrchestrator } from "@halo/scheduling/booking-orchestrator";
import { WidgetRepository } from "@/core/services/widget-repository";
import { corsHeaders, isOriginAllowed, preflightResponse } from "@/lib/api/cors";
import { clientIp, fail, withErrorHandling } from "@/lib/api/respond";
import { widgetMessageLimiter } from "@halo/platform/rate-limit";
import { isRuntimeCancelled } from "@halo/runtime/cancellation";
import { emitBusinessEvent } from "@halo/workflows/event-bus";

const bodySchema = z.object({
  visitorToken: z.string().min(16).max(128),
  message: z.string().trim().min(1).max(2000),
});

/**
 * Hard per-conversation ceiling (user + assistant rows combined). Bounds the
 * worst-case LLM spend a single visitor token can generate; real
 * receptionist chats stay far below it.
 */
const MAX_MESSAGES_PER_CONVERSATION = 200;

export const OPTIONS = (request: NextRequest) =>
  preflightResponse(request.headers.get("origin"));

/**
 * POST /api/v1/widget/messages
 * One conversational turn. Rate limited per visitor token AND per IP so a
 * single visitor can't exhaust a tenant and a single IP can't mint tokens
 * to bypass the limit.
 */
export const POST = withErrorHandling("widget.messages", async (request: NextRequest) => {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);

  const body = bodySchema.parse(await request.json().catch(() => ({})));

  const [byToken, byIp] = await Promise.all([
    widgetMessageLimiter.check(`msg:token:${body.visitorToken}`),
    widgetMessageLimiter.check(`msg:ip:${clientIp(request)}`),
  ]);
  if (!byToken.allowed || !byIp.allowed) {
    return fail(AppError.rateLimited("You're sending messages too quickly — please wait a moment"), headers);
  }

  const repository = new WidgetRepository();
  const conversation = await repository.getConversationByToken(body.visitorToken);
  if (conversation.status === "ended") {
    return fail(AppError.conflict("This conversation has ended"), headers);
  }

  const { receptionist, business, allowedDomains } = await repository.getReceptionistById(
    conversation.receptionistId,
  );
  await bindSecurityIdentity({ actorId: null, businessId: business.id });
  const unavailableAgentContext = () =>
    fail(AppError.conflict("This conversation's agent configuration is unavailable"), headers);
  if (conversation.businessId !== business.id) {
    return unavailableAgentContext();
  }

  // Same embed-domain policy as conversation start — a stolen visitor token
  // is useless from a site the business hasn't allowed.
  if (!isOriginAllowed(origin, allowedDomains)) {
    return fail(AppError.forbidden("This domain is not allowed to use this widget"), headers);
  }

  // The pinned identity tuple is persisted at conversation creation. Never
  // infer a replacement runtime from the receptionist row when linkage is
  // absent or invalid: legacy/inconsistent rows must stop before any turn is
  // written or sent to a model.
  if (
    typeof conversation.agentId !== "string" || conversation.agentId.length === 0 ||
    typeof conversation.agentVersionId !== "string" || conversation.agentVersionId.length === 0
  ) {
    return unavailableAgentContext();
  }

  const agents = new SupabaseAgentRepository();
  const agent = await agents.getAgent(conversation.agentId, business.id);
  if (
    !agent ||
    agent.type !== "receptionist" ||
    agent.slug !== conversation.receptionistId
  ) {
    // A valid same-tenant agent tuple can still belong to a different
    // receptionist profile. This also fails closed on rows produced by the
    // old migration backfill that selected one arbitrary tenant receptionist.
    return unavailableAgentContext();
  }

  const version = await agents.getVersion(
    conversation.agentVersionId,
    business.id,
  );
  if (
    !version ||
    version.businessId !== business.id ||
    version.agentId !== conversation.agentId ||
    !version.publishedAt
  ) {
    return unavailableAgentContext();
  }

  const agentContext: ResolvedAgentRuntimeContext = {
    business,
    agentId: conversation.agentId,
    agentVersionId: conversation.agentVersionId,
    agentVersion: version.version,
    config: version.config,
    promptTemplate: version.promptTemplate,
    model: version.model,
    receptionist,
  };

  if (conversation.messageCount >= MAX_MESSAGES_PER_CONVERSATION) {
    await repository.endConversation(conversation.id);
    return fail(
      AppError.conflict("This conversation has reached its limit — please start a new one"),
      headers,
    );
  }

  const chat = new ChatService(undefined, undefined, undefined, repository, new BookingOrchestrator());
  let result;
  try {
    result = await chat.respondForAgent(agentContext, {
      conversationId: conversation.id,
      userMessage: body.message,
      channel: conversation.channel,
      signal: request.signal,
    });
  } catch (error) {
    if (isRuntimeCancelled(error)) {
      return NextResponse.json({ error: { code: "REQUEST_CANCELLED", message: "Request cancelled" } }, { status: 499, headers });
    }
    throw error;
  }
  const { reply, runtime } = result;

  // Phase 2: per-turn usage/latency telemetry rides on the existing usage
  // event (tenant-safe numbers only — no transcript, no prompt).
  await repository.trackEvent(business.id, "message_sent", {
    turnId: runtime.turnId,
    provider: runtime.usage.provider,
    model: runtime.usage.model,
    modelCalls: runtime.usage.modelCalls,
    ...(runtime.usage.totalTokens !== undefined
      ? {
          inputTokens: runtime.usage.inputTokens,
          outputTokens: runtime.usage.outputTokens,
          totalTokens: runtime.usage.totalTokens,
        }
      : {}),
    latencyMs: runtime.timings.totalMs,
    modelLatencyMs: runtime.timings.modelMs,
    toolRounds: runtime.usage.toolRounds,
    escalated: runtime.escalation.escalate,
    degradedProvider: runtime.degraded.provider,
  });

  // Emitted once per conversation: the runtime raises `escalation.triggered`
  // only on the turn that first triggers it (state stays "triggered" after).
  if (runtime.events.some((event) => event.type === "escalation.triggered")) {
    // Workflow trigger for tenants who automate handoffs — fire-and-forget.
    void emitBusinessEvent({
      businessId: business.id,
      type: "conversation.escalated",
      correlationId: conversation.id,
      payload: {
        conversationId: conversation.id,
        reason: runtime.escalation.reason ?? "",
        priority: runtime.escalation.priority,
        recommendedAction: runtime.escalation.recommendedAction,
      },
    }).catch(() => {});
  }

  return NextResponse.json({ data: { reply } }, { headers });
});
