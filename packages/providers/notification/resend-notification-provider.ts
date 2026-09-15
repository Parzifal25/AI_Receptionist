import "server-only";
import type { LeadNotification, NotificationProvider } from "@halo/ports/notification-provider";
import { logger } from "@halo/platform/logger";
import { getServerEnv } from "@halo/platform/env";
import { HttpError, isTransientHttpError, withRetry } from "@halo/platform/retry";

/**
 * Resend notification provider: delivers new lead notifications to businesses
 * via email using the Resend API.
 */
export class ResendNotificationProvider implements NotificationProvider {
  readonly name = "resend";
  private readonly log = logger.child({ provider: "notification.resend" });

  async notifyNewLead(notification: LeadNotification): Promise<void> {
    const env = getServerEnv();
    if (!env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is required for resend notification provider");
    }

    const html = `
      <h1>New Lead Captured</h1>
      <p><strong>Business:</strong> ${notification.businessName} (${notification.businessId})</p>
      <h2>Lead Details</h2>
      <ul>
        <li><strong>Name:</strong> ${notification.lead.name}</li>
        <li><strong>Email:</strong> ${notification.lead.email}</li>
        <li><strong>Phone:</strong> ${notification.lead.phone}</li>
        <li><strong>Intent:</strong> ${notification.lead.intent}</li>
      </ul>
    `;
    
    const text = `New Lead Captured for ${notification.businessName}\nName: ${notification.lead.name}\nEmail: ${notification.lead.email}\nPhone: ${notification.lead.phone}\nIntent: ${notification.lead.intent}`;

    const payload = {
      from: env.RESEND_FROM_EMAIL,
      to: notification.recipientEmail,
      subject: `New Lead: ${notification.lead.name}`,
      html,
      text,
    };

    await withRetry(
      async () => {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.RESEND_API_KEY}`,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const resText = await response.text().catch(() => "");
          throw new HttpError(response.status, `Resend API error: ${response.status} ${response.statusText} ${resText}`);
        }
      },
      {
        isRetryable: isTransientHttpError,
      }
    );

    this.log.info("lead notification sent via resend", {
      businessId: notification.businessId,
      recipientEmail: notification.recipientEmail,
    });
  }
}
