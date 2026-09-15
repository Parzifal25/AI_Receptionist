import type { LeadNotification, NotificationProvider } from "@halo/ports/notification-provider";
import { logger } from "@halo/platform/logger";

/**
 * Phase 1 notification provider: emits a structured log line for every new
 * lead. Replace with an email provider (Resend, SES) by implementing
 * NotificationProvider — lead-capture code never changes.
 */
export class LogNotificationProvider implements NotificationProvider {
  readonly name = "log";
  private readonly log = logger.child({ provider: this.name });

  async notifyNewLead(notification: LeadNotification): Promise<void> {
    this.log.info("new lead captured", {
      businessId: notification.businessId,
      businessName: notification.businessName,
      recipientEmail: notification.recipientEmail,
      leadName: notification.lead.name,
      leadEmail: notification.lead.email,
      leadPhone: notification.lead.phone,
      leadIntent: notification.lead.intent,
    });
  }
}
