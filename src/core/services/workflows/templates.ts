import { workflowDefinitionSchema, type WorkflowDefinition } from "@/core/domain/workflow";

/**
 * Ready-made customer lifecycle journeys. A template is a set of workflow
 * definitions (journeys that span "wait N days" are an emitting workflow
 * plus a followup.due-triggered companion — the engine's timers carry the
 * baton between them, so a redeploy mid-wait loses nothing).
 *
 * `{{var.*}}` placeholders are filled at instantiation from tenant-supplied
 * variables; `{{event.*}}` placeholders survive into the stored definition
 * and interpolate per-run as usual.
 */

export type WorkflowDraft = Omit<WorkflowDefinition, "id" | "businessId" | "version">;

export interface WorkflowTemplateVariable {
  key: string;
  label: string;
  /** Example shown in the builder UI. */
  example: string;
  required: boolean;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  variables: WorkflowTemplateVariable[];
  workflows: WorkflowDraft[];
}

const draftSchema = workflowDefinitionSchema.omit({ id: true, businessId: true, version: true });

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "booking-journey",
    name: "Booking journey",
    description:
      "Appointment booked → welcome email → wait 24 hours → pre-visit check-in message.",
    variables: [],
    workflows: [
      {
        name: "Booking journey — welcome",
        description: "Thanks the visitor right after booking and schedules the 24h check-in.",
        trigger: "appointment.created",
        enabled: true,
        conditions: [{ path: "payload.visitorEmail", op: "exists" }],
        steps: [
          {
            id: "welcome-email",
            action: "send_email",
            params: {
              to: "{{event.payload.visitorEmail}}",
              subject: "See you soon!",
              body: "Hi {{event.payload.visitorName}}, thanks for booking {{event.payload.serviceName}} — we look forward to seeing you.",
            },
          },
          {
            id: "schedule-checkin",
            action: "schedule_followup",
            params: { delayMinutes: 1440, reason: "pre-visit-checkin" },
          },
        ],
      },
      {
        name: "Booking journey — 24h check-in",
        description: "Fires when the 24-hour timer lands.",
        trigger: "followup.due",
        enabled: true,
        conditions: [{ path: "payload.reason", op: "eq", value: "pre-visit-checkin" }],
        steps: [
          {
            id: "checkin-email",
            action: "send_email",
            params: {
              to: "{{event.payload.original.visitorEmail}}",
              subject: "Your appointment is coming up",
              body: "Hi {{event.payload.original.visitorName}}, just checking in ahead of your {{event.payload.original.serviceName}}. Reply if anything has changed!",
            },
          },
        ],
      },
    ],
  },
  {
    id: "post-visit-review",
    name: "Review & follow-up journey",
    description:
      "Appointment completed → wait 1 day → ask for a review → wait 30 days → offer a follow-up visit.",
    variables: [
      {
        key: "reviewUrl",
        label: "Public review link (Google, Yelp, …)",
        example: "https://g.page/r/your-business/review",
        required: true,
      },
    ],
    workflows: [
      {
        name: "Review journey — start",
        description: "Schedules the review ask one day after a completed visit.",
        trigger: "appointment.completed",
        enabled: true,
        conditions: [{ path: "payload.visitorEmail", op: "exists" }],
        steps: [
          {
            id: "schedule-review-ask",
            action: "schedule_followup",
            params: { delayMinutes: 1440, reason: "review-request" },
          },
        ],
      },
      {
        name: "Review journey — ask for review",
        description: "Sends the review request and schedules the 30-day rebook offer.",
        trigger: "followup.due",
        enabled: true,
        conditions: [{ path: "payload.reason", op: "eq", value: "review-request" }],
        steps: [
          {
            id: "request-review",
            action: "request_review",
            params: {
              to: "{{event.payload.original.visitorEmail}}",
              channel: "email",
              reviewUrl: "{{var.reviewUrl}}",
            },
          },
          {
            id: "schedule-rebook-offer",
            action: "schedule_followup",
            params: { delayMinutes: 43200, reason: "rebook-offer" },
          },
        ],
      },
      {
        name: "Review journey — 30-day rebook offer",
        description: "Invites the customer back a month after their visit.",
        trigger: "followup.due",
        enabled: true,
        conditions: [{ path: "payload.reason", op: "eq", value: "rebook-offer" }],
        steps: [
          {
            id: "rebook-email",
            action: "send_email",
            params: {
              to: "{{event.payload.original.visitorEmail}}",
              subject: "Time for your next visit?",
              body: "Hi {{event.payload.original.visitorName}}, it's been a month since your {{event.payload.original.serviceName}} — we'd love to see you again. Just reply or visit our site to book.",
            },
          },
        ],
      },
    ],
  },
  {
    id: "service-upsell",
    name: "Related-service upsell",
    description:
      "Appointment completed → wait 7 days → offer a related service, and log the offer on the customer's timeline.",
    variables: [
      {
        key: "serviceName",
        label: "Service to offer",
        example: "Annual maintenance plan",
        required: true,
      },
      {
        key: "offerDetails",
        label: "One line about the offer",
        example: "Two tune-ups a year plus priority scheduling, for $180.",
        required: true,
      },
    ],
    workflows: [
      {
        name: "Upsell — schedule the offer",
        description: "Waits a week after the visit so the offer lands after the work is judged.",
        trigger: "appointment.completed",
        enabled: true,
        conditions: [{ path: "payload.visitorEmail", op: "exists" }],
        steps: [
          {
            id: "schedule-upsell",
            action: "schedule_followup",
            params: { delayDays: "7", reason: "upsell-offer" },
          },
        ],
      },
      {
        name: "Upsell — related service offer",
        description: "Sends the offer and records it against the customer.",
        trigger: "followup.due",
        enabled: true,
        conditions: [{ path: "payload.reason", op: "eq", value: "upsell-offer" }],
        steps: [
          {
            id: "upsell-email",
            action: "send_email",
            params: {
              to: "{{event.payload.original.visitorEmail}}",
              subject: "Something that pairs well with your {{event.payload.original.serviceName}}",
              body: "Hi {{event.payload.original.visitorName}}, now that your {{event.payload.original.serviceName}} is done, our {{var.serviceName}} is a natural next step. {{var.offerDetails}} Just reply if you'd like it.",
            },
          },
          {
            id: "log-upsell",
            action: "crm_record_timeline",
            params: {
              email: "{{event.payload.original.visitorEmail}}",
              phone: "{{event.payload.original.visitorPhone}}",
              name: "{{event.payload.original.visitorName}}",
              kind: "upsell",
              title: "Offered {{var.serviceName}}",
            },
          },
        ],
      },
    ],
  },
  {
    id: "periodic-rebook",
    name: "Periodic rebooking",
    description:
      "Appointment completed → wait one service interval → invite the customer back for their next routine visit.",
    variables: [
      {
        key: "cadenceDays",
        label: "Days between routine visits",
        example: "90",
        required: true,
      },
      {
        key: "serviceName",
        label: "Recurring service",
        example: "seasonal system check",
        required: true,
      },
    ],
    workflows: [
      {
        name: "Periodic rebooking — arm the cadence",
        description: "Starts the service-interval timer as soon as a visit completes.",
        trigger: "appointment.completed",
        enabled: true,
        conditions: [{ path: "payload.visitorEmail", op: "exists" }],
        steps: [
          {
            id: "schedule-cadence",
            action: "schedule_followup",
            // Quoted on purpose: template variables substitute into JSON
            // strings; schedule_followup coerces the delay numerically.
            params: { delayDays: "{{var.cadenceDays}}", reason: "periodic-rebook" },
          },
        ],
      },
      {
        name: "Periodic rebooking — invite",
        description: "Invites the customer back when their interval is up.",
        trigger: "followup.due",
        enabled: true,
        conditions: [{ path: "payload.reason", op: "eq", value: "periodic-rebook" }],
        steps: [
          {
            id: "rebook-invite",
            action: "send_email",
            params: {
              to: "{{event.payload.original.visitorEmail}}",
              subject: "You're due for your {{var.serviceName}}",
              body: "Hi {{event.payload.original.visitorName}}, it's been about {{var.cadenceDays}} days since your last visit — time for your {{var.serviceName}}. Reply with a day that suits you and we'll get you booked.",
            },
          },
          {
            id: "log-rebook-offer",
            action: "crm_record_timeline",
            params: {
              email: "{{event.payload.original.visitorEmail}}",
              phone: "{{event.payload.original.visitorPhone}}",
              name: "{{event.payload.original.visitorName}}",
              kind: "rebook_offer",
              title: "Invited back for {{var.serviceName}}",
            },
          },
        ],
      },
    ],
  },
  {
    id: "no-show-recovery",
    name: "No-show recovery",
    description: "Marked no-show → friendly rebooking nudge.",
    variables: [],
    workflows: [
      {
        name: "No-show recovery",
        description: "Reaches out the moment an appointment is marked a no-show.",
        trigger: "appointment.no_show",
        enabled: true,
        conditions: [{ path: "payload.visitorEmail", op: "exists" }],
        steps: [
          {
            id: "rebook-nudge",
            action: "send_email",
            params: {
              to: "{{event.payload.visitorEmail}}",
              subject: "We missed you today",
              body: "Hi {{event.payload.visitorName}}, sorry we missed you for your {{event.payload.serviceName}}. Life happens! Reply and we'll find you a new time.",
            },
          },
        ],
      },
    ],
  },
  {
    id: "unhappy-customer-alert",
    name: "Unhappy customer alert",
    description: "Feedback under 4 stars → flag the customer record for a personal follow-up.",
    variables: [],
    workflows: [
      {
        name: "Unhappy customer alert",
        description: "Low ratings get a timeline flag so the owner follows up personally.",
        trigger: "feedback.received",
        enabled: true,
        conditions: [{ path: "payload.rating", op: "lt", value: 4 }],
        steps: [
          {
            id: "flag-customer",
            action: "crm_record_timeline",
            params: {
              email: "{{event.payload.visitorEmail}}",
              phone: "{{event.payload.visitorPhone}}",
              name: "{{event.payload.visitorName}}",
              kind: "alert",
              title: "Low rating ({{event.payload.rating}}/5) — needs a personal follow-up",
            },
          },
        ],
      },
    ],
  },
];

export function getTemplate(id: string): WorkflowTemplate | null {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** Substitutes {{var.*}} placeholders and validates the resulting drafts. */
export function instantiateTemplate(
  template: WorkflowTemplate,
  variables: Record<string, string>,
): WorkflowDraft[] {
  for (const variable of template.variables) {
    if (variable.required && !variables[variable.key]?.trim()) {
      throw new Error(`template variable "${variable.key}" is required`);
    }
  }
  const substituted = JSON.parse(
    JSON.stringify(template.workflows).replace(/\{\{var\.([a-zA-Z0-9_]+)\}\}/g, (_, key: string) =>
      // JSON-safe: variables land inside JSON string literals.
      JSON.stringify(variables[key] ?? "").slice(1, -1),
    ),
  ) as WorkflowDraft[];
  return substituted.map((draft) => draftSchema.parse(draft));
}
