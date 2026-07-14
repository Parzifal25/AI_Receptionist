import "server-only";
import type { Business } from "@/core/domain/types";
import type { Appointment, SchedulingSettings } from "@/core/domain/scheduling";
import type { MessagingProvider } from "@/core/ports/messaging-provider";
import { buildIcsEvent } from "@/lib/ics";
import { getServerEnv } from "@/lib/env";
import { getMessagingProvider } from "@/providers/messaging/factory";
import { logger } from "@/lib/logger";
import {
  buildLinks,
  confirmationEmailHtml,
  confirmationText,
  confirmationWhatsApp,
  thankYouText,
} from "./confirmation-content";

const log = logger.child({ service: "confirmation" });

/**
 * Sends every customer-facing lifecycle message on its best channel(s):
 * email gets HTML + an ICS calendar attachment, phone gets WhatsApp when the
 * provider supports it (SMS otherwise). All sends are best-effort — callers
 * fire after their primary write and treat failures as logged degradation.
 */
export class ConfirmationService {
  constructor(
    private readonly messaging: MessagingProvider = getMessagingProvider(),
    private readonly appUrl: string = getServerEnv().NEXT_PUBLIC_APP_URL,
  ) {}

  /** Booking confirmation: HTML email + ICS, and WhatsApp/SMS in parallel. */
  async sendBookingConfirmation(
    business: Business,
    appointment: Appointment,
    settings: SchedulingSettings,
    kind: "created" | "rescheduled" = "created",
  ): Promise<void> {
    const links = buildLinks(this.appUrl, appointment, settings, business);
    const text = confirmationText(business, appointment, settings, links);

    await Promise.all([
      this.trySendEmail(appointment, {
        subject:
          kind === "rescheduled"
            ? `Rescheduled: your appointment with ${business.name}`
            : `Confirmed: your appointment with ${business.name}`,
        body: text,
        html: confirmationEmailHtml(business, appointment, settings, links),
        ics: buildIcsEvent({
          uid: `appt-${appointment.id}@ai-receptionist`,
          title: `${appointment.serviceName || "Appointment"} — ${business.name}`,
          description: settings.prepInstructions || undefined,
          location: settings.locationAddress || business.address || undefined,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
          url: links.manageUrl,
          organizerName: business.name,
          attendeeName: appointment.visitorName || undefined,
          attendeeEmail: appointment.visitorEmail || undefined,
          sequence: kind === "rescheduled" ? 1 : 0,
        }),
      }),
      this.trySendPhone(appointment, confirmationWhatsApp(business, appointment, settings, links)),
    ]);
  }

  /** Cancellation notice with a CANCEL ICS so calendars clean themselves up. */
  async sendCancellation(
    business: Business,
    appointment: Appointment,
    settings: SchedulingSettings,
  ): Promise<void> {
    const links = buildLinks(this.appUrl, appointment, settings, business);
    const body =
      `Your ${appointment.serviceName || "appointment"} with ${business.name} has been cancelled. ` +
      `Book again any time${business.phone ? ` or call ${business.phone}` : ""}.`;
    await Promise.all([
      this.trySendEmail(appointment, {
        subject: `Cancelled: your appointment with ${business.name}`,
        body,
        ics: buildIcsEvent({
          uid: `appt-${appointment.id}@ai-receptionist`,
          title: `${appointment.serviceName || "Appointment"} — ${business.name}`,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
          url: links.manageUrl,
          method: "CANCEL",
          sequence: 2,
        }),
      }),
      this.trySendPhone(appointment, body),
    ]);
  }

  /** Post-visit thank-you + survey invite. */
  async sendThankYou(
    business: Business,
    appointment: Appointment,
    settings: SchedulingSettings,
  ): Promise<void> {
    const links = buildLinks(this.appUrl, appointment, settings, business);
    const body = thankYouText(business, appointment, links);
    await Promise.all([
      this.trySendEmail(appointment, {
        subject: `Thank you from ${business.name}`,
        body,
      }),
      this.trySendPhone(appointment, body),
    ]);
  }

  private async trySendEmail(
    appointment: Appointment,
    content: { subject: string; body: string; html?: string; ics?: string },
  ): Promise<void> {
    if (!appointment.visitorEmail || !this.messaging.supports("email")) return;
    try {
      await this.messaging.send({
        channel: "email",
        to: appointment.visitorEmail,
        subject: content.subject,
        body: content.body,
        html: content.html,
        attachments: content.ics
          ? [{ filename: "appointment.ics", contentType: "text/calendar; method=REQUEST", content: content.ics }]
          : undefined,
      });
    } catch (error) {
      log.warn("email send failed", { appointmentId: appointment.id, error });
    }
  }

  /** WhatsApp when the gateway supports it, SMS otherwise. */
  private async trySendPhone(appointment: Appointment, body: string): Promise<void> {
    if (!appointment.visitorPhone) return;
    const channel = this.messaging.supports("whatsapp")
      ? ("whatsapp" as const)
      : ("sms" as const);
    if (!this.messaging.supports(channel)) return;
    try {
      await this.messaging.send({ channel, to: appointment.visitorPhone, body });
    } catch (error) {
      log.warn("phone send failed", { appointmentId: appointment.id, channel, error });
    }
  }
}
