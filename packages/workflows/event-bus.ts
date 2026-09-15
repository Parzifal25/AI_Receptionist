import "server-only";
import { randomUUID } from "node:crypto";
import type { BusinessEvent, BusinessEventType } from "@halo/core/domain/workflow";
import { WorkflowEngine } from "./engine";
import { SupabaseWorkflowStore } from "./supabase-workflow-store";
import { createActionRegistry } from "./action-registry";
import { CrmService } from "@halo/crm/crm-service";
import { SupabaseCrmStore } from "@halo/crm/supabase-crm-store";
import { getMessagingProvider } from "@halo/providers/messaging/factory";
import { getOpsProvider } from "@halo/providers/ops/factory";
import { logger } from "@halo/platform/logger";

const log = logger.child({ service: "event-bus" });

let engine: WorkflowEngine | null = null;
let crm: CrmService | null = null;

export function getWorkflowEngine(): WorkflowEngine {
  if (!engine) {
    const store = new SupabaseWorkflowStore();
    engine = new WorkflowEngine(
      store,
      createActionRegistry({
        messaging: getMessagingProvider(),
        crm: getCrmService(),
        store,
        ops: getOpsProvider(),
      }),
    );
  }
  return engine;
}

export function getCrmService(): CrmService {
  if (!crm) crm = new CrmService(new SupabaseCrmStore());
  return crm;
}

export interface EmitInput {
  businessId: string;
  type: BusinessEventType;
  /** Conversation/appointment id threading the visitor's journey. */
  correlationId?: string;
  payload: Record<string, unknown>;
}

/**
 * The one front door for business events. Records the event, runs the
 * always-on CRM sync, then dispatches tenant-defined workflows. Never
 * throws and never blocks on user-visible latency guarantees beyond its
 * own work — callers fire it after their primary write has succeeded.
 */
export async function emitBusinessEvent(input: EmitInput): Promise<void> {
  const event: BusinessEvent = {
    id: randomUUID(),
    businessId: input.businessId,
    type: input.type,
    correlationId: input.correlationId ?? randomUUID(),
    occurredAt: new Date().toISOString(),
    payload: input.payload,
  };

  try {
    await syncCrm(event);
  } catch (error) {
    log.error("built-in CRM sync failed", { eventId: event.id, type: event.type, error });
  }
  // dispatch() catches internally; belt-and-braces so automation can never
  // surface into the booking/chat flow that emitted the event.
  await getWorkflowEngine()
    .dispatch(event)
    .catch((error) => log.error("workflow dispatch failed", { eventId: event.id, error }));
}

/**
 * Always-on CRM automation: every lead and appointment becomes/updates a
 * customer with a timeline entry — zero configuration required. Tenant
 * workflows layer on top for everything bespoke.
 */
async function syncCrm(event: BusinessEvent): Promise<void> {
  const p = event.payload as Partial<{
    visitorName: string;
    visitorEmail: string;
    visitorPhone: string;
    name: string;
    email: string;
    phone: string;
    serviceName: string;
    startsAt: string;
    intent: string;
    rating: number;
    comment: string;
  }>;

  const identity = {
    name: p.visitorName ?? p.name,
    email: p.visitorEmail ?? p.email,
    phone: p.visitorPhone ?? p.phone,
  };
  if (!identity.email && !identity.phone) return; // nothing to key a person on

  const service = getCrmService();

  switch (event.type) {
    case "appointment.created": {
      const { customer, created } = await service.upsertCustomer(event.businessId, {
        ...identity,
        stage: "booked",
        source: "receptionist",
      });
      await service.recordAppointment(customer);
      await service.recordTimeline(event.businessId, customer.id, {
        kind: "appointment",
        title: `Booked ${p.serviceName || "an appointment"}${p.startsAt ? ` for ${p.startsAt}` : ""}`,
        detail: { eventId: event.id, correlationId: event.correlationId },
        occurredAt: event.occurredAt,
      });
      if (created) {
        await trackCustomerCreated(event.businessId);
      }
      break;
    }
    case "appointment.rescheduled":
    case "appointment.cancelled": {
      const { customer } = await service.upsertCustomer(event.businessId, identity);
      await service.recordTimeline(event.businessId, customer.id, {
        kind: "appointment",
        title:
          event.type === "appointment.cancelled"
            ? `Cancelled ${p.serviceName || "an appointment"}`
            : `Rescheduled ${p.serviceName || "an appointment"}${p.startsAt ? ` to ${p.startsAt}` : ""}`,
        detail: { eventId: event.id, correlationId: event.correlationId },
        occurredAt: event.occurredAt,
      });
      break;
    }
    case "appointment.checked_in":
    case "appointment.no_show": {
      const { customer } = await service.upsertCustomer(event.businessId, identity);
      await service.recordTimeline(event.businessId, customer.id, {
        kind: "appointment",
        title:
          event.type === "appointment.checked_in"
            ? `Checked in for ${p.serviceName || "an appointment"}`
            : `No-show for ${p.serviceName || "an appointment"}`,
        detail: { eventId: event.id, correlationId: event.correlationId },
        occurredAt: event.occurredAt,
      });
      break;
    }
    case "appointment.completed": {
      // A completed visit makes this person a customer, funnel-wise.
      const { customer } = await service.upsertCustomer(event.businessId, {
        ...identity,
        stage: "customer",
        source: "receptionist",
      });
      await service.recordTimeline(event.businessId, customer.id, {
        kind: "appointment",
        title: `Completed ${p.serviceName || "an appointment"}`,
        detail: { eventId: event.id, correlationId: event.correlationId },
        occurredAt: event.occurredAt,
      });
      break;
    }
    case "feedback.received": {
      const { customer } = await service.upsertCustomer(event.businessId, identity);
      await service.recordTimeline(event.businessId, customer.id, {
        kind: "review",
        title: `Left feedback: ${p.rating ?? "?"}/5${p.comment ? ` — “${String(p.comment).slice(0, 120)}”` : ""}`,
        detail: { eventId: event.id, correlationId: event.correlationId, rating: p.rating },
        occurredAt: event.occurredAt,
      });
      break;
    }
    case "lead.created":
    case "lead.updated": {
      const { customer, created } = await service.upsertCustomer(event.businessId, {
        ...identity,
        stage: "engaged",
        source: "receptionist",
      });
      await service.recordTimeline(event.businessId, customer.id, {
        kind: "lead",
        title:
          event.type === "lead.created"
            ? `New lead captured${p.intent ? `: ${p.intent}` : ""}`
            : `Lead updated${p.intent ? `: ${p.intent}` : ""}`,
        detail: { eventId: event.id, correlationId: event.correlationId },
        occurredAt: event.occurredAt,
      });
      if (created) await trackCustomerCreated(event.businessId);
      break;
    }
    default:
      break;
  }
}

async function trackCustomerCreated(businessId: string): Promise<void> {
  const { getAdminClient } = await import("@halo/tenancy/supabase/admin");
  await getAdminClient()
    .from("usage_events")
    .insert({ business_id: businessId, event_type: "customer_created", metadata: {} });
}
