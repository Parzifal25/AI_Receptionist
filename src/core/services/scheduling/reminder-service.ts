import "server-only";
import type { MessagingProvider } from "@/core/ports/messaging-provider";
import { isLive } from "./appointment-state";
import { formatInTz } from "./timezone";
import { SchedulingRepository } from "./scheduling-repository";
import { getMessagingProvider } from "@/providers/messaging/factory";
import { logger } from "@/lib/logger";

const log = logger.child({ service: "reminders" });

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MINUTES = 10;

/**
 * Delivers due appointment reminders. Claiming is pessimistic (rows come
 * back already marked failed with attempts bumped — see
 * claim_due_reminders), so a crash mid-delivery can never double-send:
 * success flips the row to 'sent'; a delivery error requeues it with
 * backoff while attempts remain.
 */
export class ReminderService {
  constructor(
    private readonly repository: SchedulingRepository = new SchedulingRepository(),
    private readonly messaging: MessagingProvider = getMessagingProvider(),
  ) {}

  async processDue(batchSize = 25, now = new Date()): Promise<{ sent: number; skipped: number; failed: number }> {
    const due = await this.repository.claimDueReminders(batchSize);
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const reminder of due) {
      const appointment = await this.repository.getAppointment(reminder.appointmentId);

      // Cancelled/completed appointments (or ones already started) don't
      // get reminded — mark the row done without sending.
      if (
        !appointment ||
        !isLive(appointment.status) ||
        Date.parse(appointment.startsAt) <= now.getTime()
      ) {
        await this.repository.markReminderSent(reminder.id);
        skipped += 1;
        continue;
      }

      const to =
        reminder.channel === "email" ? appointment.visitorEmail : appointment.visitorPhone;
      if (!to || !this.messaging.supports(reminder.channel)) {
        await this.repository.recordReminderError(reminder.id, "no deliverable destination");
        failed += 1;
        continue;
      }

      try {
        await this.messaging.send({
          channel: reminder.channel,
          to,
          subject: "Appointment reminder",
          body:
            `Reminder: your ${appointment.serviceName || "appointment"} is on ` +
            `${formatInTz(appointment.startsAt, appointment.timezone)}. ` +
            `Reply or call if you need to change it.`,
        });
        await this.repository.markReminderSent(reminder.id);
        sent += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (reminder.attempts < MAX_ATTEMPTS) {
          const retryAt = new Date(now.getTime() + RETRY_BACKOFF_MINUTES * 60_000).toISOString();
          await this.repository.requeueReminder(reminder.id, retryAt, message);
        } else {
          await this.repository.recordReminderError(reminder.id, message);
        }
        log.warn("reminder delivery failed", { reminderId: reminder.id, error: message });
      }
    }

    return { sent, skipped, failed };
  }
}
