import "server-only";
import type { MessagingProvider } from "@/core/ports/messaging-provider";
import type { SchedulingSettings } from "@/core/domain/scheduling";
import { isLive } from "./appointment-state";
import { SchedulingRepository } from "./scheduling-repository";
import { directionsUrl, manageUrl, reminderText } from "@/core/services/lifecycle/confirmation-content";
import { getMessagingProvider } from "@/providers/messaging/factory";
import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

const log = logger.child({ service: "reminders" });

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MINUTES = 10;

/**
 * Delivers due appointment reminders. Claiming is pessimistic (rows come
 * back already marked failed with attempts bumped — see
 * claim_due_reminders), so a crash mid-delivery can never double-send:
 * success flips the row to 'sent'; a delivery error requeues it with
 * backoff while attempts remain. Deliveries and failures land in
 * usage_events so reminder success feeds lifecycle analytics.
 */
export class ReminderService {
  constructor(
    private readonly repository: SchedulingRepository = new SchedulingRepository(),
    private readonly messaging: MessagingProvider = getMessagingProvider(),
    private readonly appUrl: string = getServerEnv().NEXT_PUBLIC_APP_URL,
  ) {}

  async processDue(batchSize = 25, now = new Date()): Promise<{ sent: number; skipped: number; failed: number }> {
    const due = await this.repository.claimDueReminders(batchSize);
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    // Settings rarely differ within a batch; cache per business.
    const settingsCache = new Map<string, SchedulingSettings>();
    const settingsFor = async (businessId: string) => {
      let settings = settingsCache.get(businessId);
      if (!settings) {
        settings = await this.repository.getSettings(businessId);
        settingsCache.set(businessId, settings);
      }
      return settings;
    };

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
        await this.trackOutcome(reminder.businessId, "reminder_failed", reminder.appointmentId);
        failed += 1;
        continue;
      }

      try {
        const settings = await settingsFor(reminder.businessId);
        await this.messaging.send({
          channel: reminder.channel,
          to,
          subject: "Appointment reminder",
          body: reminderText(
            appointment,
            {
              manageUrl: manageUrl(this.appUrl, appointment.manageToken),
              directionsUrl: directionsUrl(settings.locationAddress),
            },
            settings,
          ),
        });
        await this.repository.markReminderSent(reminder.id);
        await this.trackOutcome(reminder.businessId, "reminder_sent", reminder.appointmentId);
        sent += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (reminder.attempts < MAX_ATTEMPTS) {
          const retryAt = new Date(now.getTime() + RETRY_BACKOFF_MINUTES * 60_000).toISOString();
          await this.repository.requeueReminder(reminder.id, retryAt, message);
        } else {
          await this.repository.recordReminderError(reminder.id, message);
          await this.trackOutcome(reminder.businessId, "reminder_failed", reminder.appointmentId);
        }
        log.warn("reminder delivery failed", { reminderId: reminder.id, error: message });
      }
    }

    return { sent, skipped, failed };
  }

  private async trackOutcome(
    businessId: string,
    outcome: "reminder_sent" | "reminder_failed",
    appointmentId: string,
  ): Promise<void> {
    await this.repository
      .trackEvent(businessId, outcome, { appointmentId })
      .catch((error) => log.warn("reminder analytics failed", { error }));
  }
}
