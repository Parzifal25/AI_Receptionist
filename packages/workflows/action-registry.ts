import "server-only";
import type { MessageChannel, MessagingProvider } from "@halo/ports/messaging-provider";
import type { OpsProvider, OpsRecordKind } from "@halo/ports/ops-provider";
import { OPS_RECORD_KINDS } from "@halo/ports/ops-provider";
import type { ActionContext, ActionRegistry, WorkflowStore } from "./types";
import type { CrmService, CustomerStage } from "@halo/crm/crm-service";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { assertPublicHttpsUrl } from "@halo/platform/ssrf";
import { logger } from "@halo/platform/logger";

const log = logger.child({ service: "workflow-actions" });

/** Human labels for ops records on the customer timeline. */
const OPS_RECORD_LABELS: Record<OpsRecordKind, string> = {
  fsm_ticket: "Service ticket",
  technician_job: "Technician job",
  quote: "Quote",
  invoice: "Invoice",
  inventory_reservation: "Inventory reservation",
  payment: "Payment",
};

/**
 * The built-in workflow actions. Every action talks to a port (messaging),
 * the CRM service, the workflow store, or a tenant-supplied webhook URL —
 * never a hard-coded third-party API. Slack, Discord, Zapier, n8n, Make,
 * Third-party CRMs and FSMs plug in as `call_webhook`
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
  /** Back-office operations back-end for the ops_create action. */
  ops?: OpsProvider;
  /** usage_events writer override for tests; production inserts via admin. */
  trackUsage?: (
    businessId: string,
    eventType: string,
    metadata: Record<string, unknown>,
  ) => Promise<void>;
  fetchImpl?: typeof fetch;
  /** DNS resolution override for tests; production uses dns.promises.lookup. */
  lookupImpl?: Parameters<typeof assertPublicHttpsUrl>[1];
}): ActionRegistry {
  const { messaging, crm, store } = deps;
  // Lazy so tests without env never construct the default provider.
  const getOps = async (): Promise<OpsProvider> =>
    deps.ops ?? (await import("@halo/providers/ops/factory")).getOpsProvider();
  const trackUsage =
    deps.trackUsage ??
    (async (businessId: string, eventType: string, metadata: Record<string, unknown>) => {
      const { error } = await getAdminClient()
        .from("usage_events")
        .insert({ business_id: businessId, event_type: eventType, metadata });
      if (error) throw new Error(`track ${eventType}: ${error.message}`);
    });
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

    /**
     * Arms a timer that re-enters the engine as `followup.due`. The delay is
     * given in minutes, or in days for cadence-shaped journeys ("invite them
     * back every 90 days") where a minute count would be unreadable — days
     * win when both are supplied. Capped at a year so a templated variable
     * can never park a timer beyond any plausible retention window.
     */
    schedule_followup: async (params, ctx) => {
      const days = Number(params.delayDays);
      const delayMinutes = Number.isFinite(days) && days > 0 ? days * 1440 : Number(params.delayMinutes);
      if (!Number.isFinite(delayMinutes) || delayMinutes <= 0) {
        throw new Error(`schedule_followup needs a positive "delayMinutes" or "delayDays"`);
      }
      if (delayMinutes > 365 * 1440) {
        throw new Error(`schedule_followup delay exceeds the one-year maximum`);
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

    /**
     * Review request: messages the visitor a link to the business's public
     * review destination and records the ask so review rate is measurable.
     * to/reviewUrl usually interpolate from the event payload / settings.
     */
    request_review: async (params, ctx) => {
      const reviewUrl = requireParam(params, "reviewUrl");
      const to = requireParam(params, "to");
      const channel = (str(params.channel) || "email") as MessageChannel;
      if (!messaging.supports(channel)) {
        throw new Error(`messaging provider "${messaging.name}" does not support ${channel}`);
      }
      const body =
        str(params.body) ||
        `Thanks for your visit! If you have a moment, a quick review means the world to us: ${reviewUrl}`;
      await messaging.send({
        channel,
        to,
        body,
        subject: str(params.subject) || "How did we do?",
      });
      await trackUsage(ctx.businessId, "review_requested", {
        correlationId: ctx.correlationId,
        channel,
      });
      return { channel, to, reviewUrl };
    },

    /**
     * Creates one back-office record (FSM ticket, technician job, quote,
     * invoice, inventory reservation, payment) through the OpsProvider port.
     */
    ops_create: async (params, ctx) => {
      const kind = str(params.kind) as OpsRecordKind;
      if (!OPS_RECORD_KINDS.includes(kind)) {
        throw new Error(
          `ops_create "kind" must be one of ${OPS_RECORD_KINDS.join(", ")} (got "${kind || "nothing"}")`,
        );
      }
      const ops = await getOps();
      if (!ops.supports(kind)) {
        throw new Error(`ops provider "${ops.name}" does not support ${kind}`);
      }
      const data =
        params.data && typeof params.data === "object" && !Array.isArray(params.data)
          ? (params.data as Record<string, unknown>)
          : {};
      const email = str(params.email) || undefined;
      const phone = str(params.phone) || undefined;
      const result = await ops.createRecord({
        kind,
        businessId: ctx.businessId,
        correlationId: ctx.correlationId,
        customer: { name: str(params.name) || undefined, email, phone },
        data,
      });

      // The downstream record now exists. Mirroring it onto the customer
      // timeline is best-effort on purpose: throwing here would make the
      // engine retry the step and create a SECOND ticket/invoice/payment.
      let timelined = false;
      if (email || phone) {
        try {
          const { customer } = await crm.upsertCustomer(ctx.businessId, {
            name: str(params.name) || undefined,
            email,
            phone,
          });
          await crm.recordTimeline(ctx.businessId, customer.id, {
            kind,
            title: `${OPS_RECORD_LABELS[kind]} created (${result.externalId})`,
            detail: {
              externalId: result.externalId,
              provider: ops.name,
              eventId: ctx.event.id,
              ...data,
            },
            occurredAt: ctx.event.occurredAt,
          });
          // A recorded payment is money that actually moved — attribute it
          // so lifetime value and revenue reporting stay honest.
          const amount = Number(data.amount);
          if (kind === "payment" && Number.isFinite(amount) && amount > 0) {
            await crm.recordRevenue(customer, amount);
          }
          timelined = true;
        } catch (error) {
          log.warn("ops record created but not timelined", {
            kind,
            externalId: result.externalId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { kind, externalId: result.externalId, provider: ops.name, timelined };
    },

    track_analytics: async (params, ctx) => {
      await trackUsage(ctx.businessId, "workflow_custom", {
        name: str(params.name) || ctx.event.type,
        correlationId: ctx.correlationId,
      });
    },
  };
}
