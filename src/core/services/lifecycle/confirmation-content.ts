import type { Business } from "@/core/domain/types";
import type { Appointment, SchedulingSettings } from "@/core/domain/scheduling";
import { formatInTz } from "@/core/services/scheduling/timezone";

/**
 * Pure builders for every customer-facing lifecycle message: confirmation
 * email (HTML + text), WhatsApp/SMS confirmations, reminder copy, thank-you
 * and review requests. No I/O — the ConfirmationService and ReminderService
 * do the sending; these functions are the single source of wording, so tests
 * pin the content and channels can never drift apart.
 */

export interface LifecycleLinks {
  /** Self-service page: reschedule, cancel, check in, intake, feedback. */
  manageUrl: string;
  /** Google Maps directions, empty when the business has no address. */
  directionsUrl: string;
}

/** The manage page URL for an appointment's capability token. */
export function manageUrl(appUrl: string, manageToken: string): string {
  return `${appUrl.replace(/\/$/, "")}/appt/${encodeURIComponent(manageToken)}`;
}

/** Google Maps directions deep link for a street address. */
export function directionsUrl(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) return "";
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(trimmed)}`;
}

export function buildLinks(
  appUrl: string,
  appointment: Appointment,
  settings: SchedulingSettings,
  business: Business,
): LifecycleLinks {
  return {
    manageUrl: manageUrl(appUrl, appointment.manageToken),
    directionsUrl: directionsUrl(settings.locationAddress || business.address),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const label = (appointment: Appointment) => appointment.serviceName || "appointment";
const when = (appointment: Appointment) =>
  formatInTz(appointment.startsAt, appointment.timezone);

/** Plain-text confirmation — SMS body and the email text alternative. */
export function confirmationText(
  business: Business,
  appointment: Appointment,
  settings: SchedulingSettings,
  links: LifecycleLinks,
): string {
  const lines = [
    `You're booked! ${label(appointment)} with ${business.name} on ${when(appointment)}.`,
  ];
  if (links.directionsUrl) lines.push(`Directions: ${links.directionsUrl}`);
  if (settings.prepInstructions) lines.push(`How to prepare: ${settings.prepInstructions}`);
  if (settings.intakeForm.length > 0) {
    lines.push(`Please fill in your intake form before your visit: ${links.manageUrl}`);
  }
  lines.push(`Manage your booking (reschedule or cancel): ${links.manageUrl}`);
  if (business.phone) lines.push(`Questions? Call ${business.phone}.`);
  return lines.join("\n");
}

/** WhatsApp variant — same facts, lightly formatted. */
export function confirmationWhatsApp(
  business: Business,
  appointment: Appointment,
  settings: SchedulingSettings,
  links: LifecycleLinks,
): string {
  return confirmationText(business, appointment, settings, links);
}

/** Responsive HTML confirmation email. */
export function confirmationEmailHtml(
  business: Business,
  appointment: Appointment,
  settings: SchedulingSettings,
  links: LifecycleLinks,
): string {
  const rows: Array<[string, string]> = [
    ["Service", label(appointment)],
    ["When", when(appointment)],
  ];
  const address = settings.locationAddress || business.address;
  if (address) rows.push(["Where", address]);
  if (appointment.visitorName) rows.push(["Booked for", appointment.visitorName]);

  const detailRows = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;white-space:nowrap;">${escapeHtml(k)}</td>` +
        `<td style="padding:6px 0;color:#111827;font-weight:600;">${escapeHtml(v)}</td></tr>`,
    )
    .join("");

  const button = (href: string, text: string, primary: boolean) =>
    `<a href="${escapeHtml(href)}" style="display:inline-block;margin:4px 8px 4px 0;padding:10px 18px;` +
    `border-radius:8px;text-decoration:none;font-weight:600;` +
    (primary
      ? "background:#2563eb;color:#ffffff;"
      : "background:#f3f4f6;color:#111827;border:1px solid #e5e7eb;") +
    `">${escapeHtml(text)}</a>`;

  const buttons = [button(links.manageUrl, "Manage booking", true)];
  if (links.directionsUrl) buttons.push(button(links.directionsUrl, "Get directions", false));

  const prep = settings.prepInstructions
    ? `<h3 style="margin:24px 0 8px;font-size:15px;color:#111827;">How to prepare</h3>` +
      `<p style="margin:0;color:#374151;line-height:1.6;">${escapeHtml(settings.prepInstructions)}</p>`
    : "";

  const intake =
    settings.intakeForm.length > 0
      ? `<p style="margin:16px 0 0;color:#374151;line-height:1.6;">Please complete your ` +
        `<a href="${escapeHtml(links.manageUrl)}" style="color:#2563eb;">intake form</a> before your visit — it only takes a minute.</p>`
      : "";

  return (
    `<div style="max-width:560px;margin:0 auto;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:24px;">` +
    `<h2 style="margin:0 0 4px;font-size:20px;color:#111827;">You're booked with ${escapeHtml(business.name)}</h2>` +
    `<p style="margin:0 0 20px;color:#6b7280;">We look forward to seeing you.</p>` +
    `<table style="border-collapse:collapse;font-size:14px;">${detailRows}</table>` +
    `<div style="margin:20px 0 0;">${buttons.join("")}</div>` +
    prep +
    intake +
    `<p style="margin:24px 0 0;color:#9ca3af;font-size:12px;">A calendar invite is attached. ` +
    (business.phone ? `Questions? Call ${escapeHtml(business.phone)}.` : "") +
    `</p></div>`
  );
}

/** Reminder copy — includes manage link so "reschedule" is one tap away. */
export function reminderText(
  appointment: Appointment,
  links: LifecycleLinks,
  settings: SchedulingSettings,
): string {
  const lines = [
    `Reminder: your ${label(appointment)} is on ${when(appointment)}.`,
  ];
  if (settings.prepInstructions) lines.push(`How to prepare: ${settings.prepInstructions}`);
  if (links.directionsUrl) lines.push(`Directions: ${links.directionsUrl}`);
  lines.push(`Need to change it? ${links.manageUrl}`);
  return lines.join("\n");
}

/** Post-visit thank-you + satisfaction survey invite. */
export function thankYouText(
  business: Business,
  appointment: Appointment,
  links: LifecycleLinks,
): string {
  return (
    `Thanks for visiting ${business.name}! We hope your ${label(appointment)} went well.\n` +
    `We'd love your feedback — it takes 30 seconds: ${links.manageUrl}#feedback`
  );
}

/** Review request pointing at the business's public review destination. */
export function reviewRequestText(business: Business, reviewUrl: string): string {
  return (
    `Thanks again for choosing ${business.name}! ` +
    `If you have a moment, a quick review means the world to us: ${reviewUrl}`
  );
}
