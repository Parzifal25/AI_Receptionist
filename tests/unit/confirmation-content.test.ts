import { describe, expect, it } from "vitest";
import type { Business } from "@halo/core/domain/types";
import type { Appointment, SchedulingSettings } from "@halo/core/domain/scheduling";
import {
  buildLinks,
  confirmationEmailHtml,
  confirmationText,
  directionsUrl,
  manageUrl,
  reminderText,
  reviewRequestText,
  thankYouText,
} from "@halo/lifecycle/confirmation-content";

const business: Business = {
  id: "b1",
  name: "Cool Air HVAC",
  slug: "cool-air",
  description: "",
  industry: "HVAC",
  website: "",
  phone: "+1 555 0199",
  email: "",
  address: "99 Fallback Ave",
  businessHours: {},
  logoUrl: "",
};

const settings: SchedulingSettings = {
  businessId: "b1",
  bookingEnabled: true,
  timezone: "America/New_York",
  slotDurationMinutes: 60,
  bufferMinutes: 0,
  minNoticeMinutes: 120,
  maxAdvanceDays: 14,
  holidays: [],
  remindersEnabled: true,
  reminderLeadMinutes: [60],
  locationAddress: "12 Main St, Springfield",
  prepInstructions: "Please clear access to the unit.",
  intakeForm: [{ id: "issue", label: "Describe the issue", type: "text", required: true }],
  reviewUrl: "https://g.page/cool-air/review",
  autoNoShowEnabled: false,
  noShowGraceMinutes: 30,
};

const appointment: Appointment = {
  id: "a1",
  businessId: "b1",
  staffId: "s1",
  conversationId: "c1",
  leadId: null,
  serviceName: "AC servicing",
  visitorName: "Sam <script>",
  visitorPhone: "+1 555 0100",
  visitorEmail: "sam@example.com",
  startsAt: "2026-07-14T13:00:00.000Z",
  endsAt: "2026-07-14T14:00:00.000Z",
  timezone: "America/New_York",
  status: "confirmed",
  externalEventId: "",
  manageToken: "11111111-1111-4111-8111-111111111111",
  notes: "",
  createdAt: "2026-07-13T12:00:00.000Z",
};

const links = buildLinks("https://app.test/", appointment, settings, business);

describe("links", () => {
  it("builds the manage URL from the app URL and token", () => {
    expect(manageUrl("https://app.test/", "tok-1")).toBe("https://app.test/appt/tok-1");
    expect(links.manageUrl).toBe(`https://app.test/appt/${appointment.manageToken}`);
  });

  it("builds a Google Maps directions link, preferring the scheduling address", () => {
    expect(links.directionsUrl).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=12%20Main%20St%2C%20Springfield",
    );
    expect(directionsUrl("")).toBe("");
  });

  it("falls back to the business address when scheduling has none", () => {
    const fallback = buildLinks(
      "https://app.test",
      appointment,
      { ...settings, locationAddress: "" },
      business,
    );
    expect(fallback.directionsUrl).toContain("99%20Fallback%20Ave");
  });
});

describe("confirmationText", () => {
  it("carries the when, directions, prep, intake nudge, and manage link", () => {
    const text = confirmationText(business, appointment, settings, links);
    expect(text).toContain("Tuesday, July 14 at 9:00 AM");
    expect(text).toContain(links.directionsUrl);
    expect(text).toContain("Please clear access to the unit.");
    expect(text).toContain("intake form");
    expect(text).toContain(links.manageUrl);
    expect(text).toContain("+1 555 0199");
  });
});

describe("confirmationEmailHtml", () => {
  it("escapes visitor-controlled content", () => {
    const html = confirmationEmailHtml(business, appointment, settings, links);
    expect(html).not.toContain("<script>");
    expect(html).toContain("Sam &lt;script&gt;");
  });

  it("renders manage and directions buttons plus prep copy", () => {
    const html = confirmationEmailHtml(business, appointment, settings, links);
    expect(html).toContain(links.manageUrl);
    // Attribute-escaped (& → &amp;) form of the directions link.
    expect(html).toContain(links.directionsUrl.replace(/&/g, "&amp;"));
    expect(html).toContain("How to prepare");
  });
});

describe("reminder / post-visit copy", () => {
  it("reminder includes the reschedule link", () => {
    const text = reminderText(appointment, links, settings);
    expect(text).toContain("Reminder: your AC servicing");
    expect(text).toContain(links.manageUrl);
  });

  it("thank-you points at the feedback anchor", () => {
    expect(thankYouText(business, appointment, links)).toContain(`${links.manageUrl}#feedback`);
  });

  it("review request carries the public review URL", () => {
    expect(reviewRequestText(business, settings.reviewUrl)).toContain(settings.reviewUrl);
  });
});
