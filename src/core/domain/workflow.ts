import { z } from "zod";

/**
 * Workflow automation domain. A BusinessEvent is anything that happened in
 * the product (appointment booked, lead captured…); a Workflow is a tenant's
 * recipe for reacting to one kind of event: optional conditions on the event
 * payload, then a list of actions executed in order. The engine — not these
 * types — owns retries, idempotency, and history.
 */

export const BUSINESS_EVENT_TYPES = [
  "appointment.created",
  "appointment.rescheduled",
  "appointment.cancelled",
  "lead.created",
  "lead.updated",
  "conversation.started",
  "conversation.archived",
  "customer.created",
  "customer.updated",
  "followup.due",
  "webhook.received",
  "manual",
] as const;

export type BusinessEventType = (typeof BUSINESS_EVENT_TYPES)[number];

export interface BusinessEvent {
  /** Stable id — the idempotency anchor for run creation. */
  id: string;
  businessId: string;
  type: BusinessEventType;
  /** Threads one visitor journey across events, runs, and logs. */
  correlationId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/** Everything a workflow step can do. Executors live in the action registry. */
export const WORKFLOW_ACTION_TYPES = [
  "send_email",
  "send_sms",
  "send_whatsapp",
  "call_webhook",
  "crm_upsert_customer",
  "crm_record_timeline",
  "crm_record_revenue",
  "schedule_followup",
  "track_analytics",
] as const;

export type WorkflowActionType = (typeof WORKFLOW_ACTION_TYPES)[number];

const conditionSchema = z.object({
  /** Dot path into the event, e.g. "payload.serviceName". */
  path: z.string().min(1),
  op: z.enum(["eq", "neq", "contains", "exists", "not_exists", "gt", "lt"]),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const stepSchema = z.object({
  /** Stable per-workflow step id, used in logs and resume-on-retry. */
  id: z.string().min(1),
  action: z.enum(WORKFLOW_ACTION_TYPES),
  /**
   * Action parameters. String values support {{event.…}} interpolation,
   * e.g. { to: "{{event.payload.visitorEmail}}", body: "Thanks {{event.payload.visitorName}}!" }.
   */
  params: z.record(z.string(), z.unknown()).default({}),
  /** Per-step in-run retries (on top of run-level cron retries). */
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).max(5).default(1),
      backoffMs: z.number().int().min(0).max(60_000).default(1_000),
    })
    .optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
});

export const workflowDefinitionSchema = z.object({
  id: z.string(),
  businessId: z.string(),
  name: z.string().min(1),
  description: z.string().default(""),
  trigger: z.enum(BUSINESS_EVENT_TYPES),
  enabled: z.boolean().default(true),
  version: z.number().int().min(1).default(1),
  conditions: z.array(conditionSchema).default([]),
  steps: z.array(stepSchema).min(1),
});

export type WorkflowCondition = z.infer<typeof conditionSchema>;
export type WorkflowStep = z.infer<typeof stepSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "dead_letter";

export interface WorkflowRun {
  id: string;
  workflowId: string;
  businessId: string;
  eventId: string;
  workflowVersion: number;
  status: WorkflowRunStatus;
  /** Run-level attempts consumed (cron retries). */
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  /** Index of the first step that has not succeeded — retries resume here. */
  currentStep: number;
  correlationId: string;
  error: string;
}

export interface WorkflowStepLog {
  runId: string;
  stepId: string;
  attempt: number;
  status: "succeeded" | "failed" | "skipped";
  detail: Record<string, unknown>;
}
