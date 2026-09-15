import "server-only";
import { z } from "zod";
import type { Appointment } from "@halo/core/domain/scheduling";
import { AppError } from "@halo/core/errors/app-error";
import { SchedulingRepository } from "@halo/scheduling/scheduling-repository";
import { emitBusinessEvent, type EmitInput } from "@halo/workflows/event-bus";
import { appointmentEventPayload } from "./lifecycle-service";
import { logger } from "@halo/platform/logger";

const log = logger.child({ service: "feedback" });

export const feedbackSchema = z.object({
  rating: z.number().int().min(1).max(5),
  nps: z.number().int().min(0).max(10).nullish(),
  comment: z.string().max(2000).default(""),
});

export type FeedbackInput = z.infer<typeof feedbackSchema>;

/**
 * Customer satisfaction surveys and review feedback. A survey is valid once
 * the visit has happened (completed, or past its start without being
 * cancelled); resubmission revises the earlier answer. Every submission
 * emits feedback.received so workflows can thank, escalate a bad rating,
 * or forward a great one to the public review flow.
 */
export class FeedbackService {
  constructor(
    private readonly repository: SchedulingRepository = new SchedulingRepository(),
    private readonly emitEvent: (input: EmitInput) => Promise<void> = emitBusinessEvent,
  ) {}

  canAcceptFeedback(appointment: Appointment, now = new Date()): boolean {
    if (appointment.status === "cancelled") return false;
    if (appointment.status === "completed") return true;
    return Date.parse(appointment.startsAt) <= now.getTime();
  }

  async submit(
    appointment: Appointment,
    input: FeedbackInput,
    now = new Date(),
  ): Promise<void> {
    if (!this.canAcceptFeedback(appointment, now)) {
      throw AppError.conflict("Feedback opens after your appointment");
    }

    await this.repository.upsertFeedback({
      appointmentId: appointment.id,
      businessId: appointment.businessId,
      rating: input.rating,
      nps: input.nps ?? null,
      comment: input.comment,
    });

    await this.repository
      .trackEvent(appointment.businessId, "feedback_received", {
        appointmentId: appointment.id,
        rating: input.rating,
      })
      .catch((error) => log.warn("feedback analytics failed", { error }));

    void this.emitEvent({
      businessId: appointment.businessId,
      type: "feedback.received",
      correlationId: appointment.conversationId ?? appointment.id,
      payload: {
        ...appointmentEventPayload(appointment),
        rating: input.rating,
        nps: input.nps ?? null,
        comment: input.comment,
      },
    }).catch((error) => log.warn("feedback event emit failed", { error }));
  }
}
