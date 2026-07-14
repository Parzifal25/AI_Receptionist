import "server-only";
import type { MessageChannel, MessagingProvider } from "@/core/ports/messaging-provider";
import type { ActionContext, ActionRegistry, WorkflowStore } from "./types";
import type { CrmService, CustomerStage } from "@/core/services/crm/crm-service";
import { getAdminClient } from "@/lib/supabase/admin";
import { assertPublicHttpsUrl } from "@/lib/ssrf";

/**
 * The built-in workflow actions. Every action talks to a port (messaging),
 * the CRM service, the workflow store, or a tenant-supplied webhook URL —
 * never a hard-coded third-party API. Slack, Discord, Zapier, n8n, Make,
 * HubSpot, Salesforce, OpsCorp FSM and friends all plug in as `call_webhook`
 * targets (each of those platforms mints inbound-webhook URLs); dedicated
 * first-class adapters can later slot in as new action types without
 * touching the engine.
 */

function str(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
}

function requireParam(params: Record<string, unknown>, key: string): string {
  const value = str(params[key]).trim();
  if (!value) throw new Error(`action param "${key}" is required and resolved empty`);
  return value;
}

function messagingAction(messaging: MessagingProvider, channel: MessageChannel) {
  return async (params: Record<string, unknown>) => {
    const to = requireParam(params, "to");
    const body = requireParam(params, "body");
    if (!messaging.supports(channel)) {
      throw new Error(`messaging provider "${messaging.name}" does not support ${channel}`);
    }
    await messaging.send({ channel, to, body, subject: str(params.subject) || undefined });
    return { channel, to };
  };
}

/**
 * Formats the outbound webhook body for the receiving platform. "slack" and
 * "discord" wrap a text summary the way those webhooks expect; "json"
 * (default — Zapier/n8n/Make/custom) sends the event envelope itself.
 */
function webhookBody(
  format: string,
  params: Record<string, unknown>,
  ctx: ActionContext,
): Record<string, unknown> {
  const text = str(params.text) || `${ctx.event.type} — ${ctx.correlationId}`;
  if (format === "slack") return { text };
  if (format === "discord") return { content: text };
  return {
    event: ctx.event.type,
    eventId: ctx.event.id,
    correlationId: ctx.correlationId,
    occurredAt: ctx.event.occurredAt,
    payload: ctx.event.payload,
    ...(str(params.text) ? { text } : {}),
  };
}

export function createActionRegistry(deps: {
  messaging: MessagingProvider;
  crm: CrmService;
  store: WorkflowStore;
  fetchImpl?: typeof fetch;
  /** DNS resolution override for tests; production uses dns.promises.lookup. */
  lookupImpl?: Parameters<typeof assertPublicHttpsUrl>[1];
}): ActionRegistry {
  const { messaging, crm, store } = deps;
  const doFetch = deps.fetchImpl ?? fetch;

  return {
    send_email: messagingAction(messaging, "email"),
    send_sms: messagingAction(messaging, "sms"),
    send_whatsapp: messagingAction(messaging, "whatsapp"),

    call_webhook: async (params, ctx) => {
      // SSRF guard: tenant-supplied URL must be https and resolve only to
      // publicly routable addresses (no loopback/private/link-local/metadata).
      const target = await assertPublicHttpsUrl(requireParam(params, "url"), deps.lookupImpl);
      const format = str(params.format) || "json";
      const response = await doFetch(target.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-event-id": ctx.event.id,
          "x-correlation-id": ctx.correlationId,
        },
        body: JSON.stringify(webhookBody(format, params, ctx)),
        // Never follow redirects — a public host could 302 into a private
        // one. A 3xx counts as a failed delivery (not response.ok).
        redirect: "manual",
      });
      if (!response.ok) throw new Error(`webhook responded ${response.status}`);
      return { url: target.toString(), status: response.status, format };
    },

    crm_upsert_customer: async (params, ctx) => {
      const { customer, created } = await crm.upsertCustomer(ctx.businessId, {
        name: str(params.name) || undefined,
        email: str(params.email) || undefined,
        phone: str(params.phone) || undefined,
        stage: (str(params.stage) || undefined) as CustomerStage | undefined,
        source: str(params.source) || undefined,
      });
      return { customerId: customer.id, created };
    },

    crm_record_timeline: async (params, ctx) => {
      const { customer } = await crm.upsertCustomer(ctx.businessId, {
        email: str(params.email) || undefined,
        phone: str(params.phone) || undefined,
        name: str(params.name) || undefined,
      });
      await crm.recordTimeline(ctx.businessId, customer.id, {
        kind: str(params.kind) || ctx.event.type,
        title: requireParam(params, "title"),
        detail: { eventId: ctx.event.id },
        occurredAt: ctx.event.occurredAt,
      });
      return { customerId: customer.id };
    },

    crm_record_revenue: async (params, ctx) => {
      const amount = Number(params.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(`crm_record_revenue needs a positive numeric "amount"`);
      }
      const { customer } = await crm.upsertCustomer(ctx.businessId, {
        email: str(params.email) || undefined,
        phone: str(params.phone) || undefined,
      });
      await crm.recordRevenue(customer, amount);
      await crm.recordTimeline(ctx.businessId, customer.id, {
        kind: "revenue",
        title: `Revenue recorded: ${amount}`,
        detail: { amount, eventId: ctx.event.id },
      });
      return { customerId: customer.id, amount };
    },

    schedule_followup: async (params, ctx) => {
      const delayMinutes = Number(params.delayMinutes);
      if (!Number.isFinite(delayMinutes) || delayMinutes <= 0) {
        throw new Error(`schedule_followup needs a positive "delayMinutes"`);
      }
      const fireAt = new Date(Date.now() + delayMinutes * 60_000).toISOString();
      await store.scheduleTimer({
        businessId: ctx.businessId,
        eventType: "followup.due",
        payload: {
          reason: str(params.reason) || "follow-up",
          source: ctx.event.type,
          original: ctx.event.payload,
        },
        correlationId: ctx.correlationId,
        fireAt,
      });
      return { fireAt };
    },

    track_analytics: async (params, ctx) => {
      const { error } = await getAdminClient().from("usage_events").insert({
        business_id: ctx.businessId,
        event_type: "workflow_custom",
        metadata: { name: str(params.name) || ctx.event.type, correlationId: ctx.correlationId },
      });
      if (error) throw new Error(`track analytics: ${error.message}`);
    },
  };
}
