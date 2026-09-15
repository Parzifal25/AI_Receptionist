import { describe, expect, it } from "vitest";
import type { Business } from "@halo/core/domain/types";
import type {
  Appointment,
  AppointmentFeedback,
  AppointmentStatus,
  SchedulingSettings,
} from "@halo/core/domain/scheduling";
import type { MessagingProvider, OutboundMessage } from "@halo/ports/messaging-provider";
import type { SchedulingRepository } from "@halo/scheduling/scheduling-repository";
import { AppointmentLifecycleService } from "@halo/lifecycle/lifecycle-service";
import { FeedbackService } from "@halo/lifecycle/feedback-service";
import { ConfirmationService } from "@halo/lifecycle/confirmation-service";

/**
 * During/after-appointment lifecycle against in-memory fakes: day-of status
 * tracking, reminder cleanup, thank-you delivery, feedback capture, and the
 * business events that feed review/rebook workflows.
 */

const NOW = new Date("2026-07-14T15:00:00Z");

const business: Business = {
  id: "b1",
  name: "Cool Air HVAC",
  slug: "cool-air",
  description: "",
  industry: "HVAC",
  website: "",
  phone: "+1 555 0199",
  email: "",
  address: "",
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
  locationAddress: "",
  prepInstructions: "",
  intakeForm: [],
  reviewUrl: "https://g.page/cool-air/review",
  autoNoShowEnabled: false,
  noShowGraceMinutes: 30,
};

function makeAppointment(status: AppointmentStatus, startsAt = "2026-07-14T13:00:00.000Z"): Appointment {
  return {
    id: "a1",
    businessId: "b1",
    staffId: "s1",
    conversationId: "c1",
    leadId: null,
    serviceName: "AC servicing",
    visitorName: "Sam",
    visitorPhone: "+1 555 0100",
    visitorEmail: "sam@example.com",
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
    timezone: "America/New_York",
    status,
    externalEventId: "",
    manageToken: "11111111-1111-4111-8111-111111111111",
    notes: "",
    createdAt: "2026-07-13T12:00:00.000Z",
  };
}

function buildFakes() {
  const statusWrites: Array<{ id: string; status: string; note: string }> = [];
  const cancelledReminders: string[] = [];
  const tracked: string[] = [];
  const feedbackRows: AppointmentFeedback[] = [];

  const repository = {
    async updateAppointmentStatus(id: string, status: string, note = "") {
      statusWrites.push({ id, status, note });
    },
    async cancelReminders(appointmentId: string) {
      cancelledReminders.push(appointmentId);
    },
    async trackEvent(_businessId: string, eventType: string) {
      tracked.push(eventType);
    },
    async getSettings() {
      return settings;
    },
    async upsertFeedback(feedback: AppointmentFeedback) {
      feedbackRows.push(feedback);
    },
  } as unknown as SchedulingRepository;

  const sent: OutboundMessage[] = [];
  const messaging: MessagingProvider = {
    name: "fake",
    supports: () => true,
    async send(message) {
      sent.push(message);
    },
  };

  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const emit = async (input: { type: string; payload: Record<string, unknown> }) => {
    emitted.push({ type: input.type, payload: input.payload });
  };

  const lifecycle = new AppointmentLifecycleService(
    repository,
    new ConfirmationService(messaging, "http://app.test"),
    emit as never,
  );
  const feedback = new FeedbackService(repository, emit as never);

  return { lifecycle, feedback, statusWrites, cancelledReminders, tracked, sent, emitted, feedbackRows };
}

describe("AppointmentLifecycleService", () => {
  it("tracks check-in and emits the business event", async () => {
    const fakes = buildFakes();
    const updated = await fakes.lifecycle.transition(business, makeAppointment("confirmed"), "checked_in");

    expect(updated.status).toBe("checked_in");
    expect(fakes.statusWrites).toEqual([
      { id: "a1", status: "checked_in", note: "Visitor checked in." },
    ]);
    expect(fakes.tracked).toContain("appointment_checked_in");
    expect(fakes.emitted.map((e) => e.type)).toEqual(["appointment.checked_in"]);
    expect(fakes.cancelledReminders).toHaveLength(0); // still upcoming for staff
  });

  it("completion cancels reminders, thanks the visitor, and emits appointment.completed", async () => {
    const fakes = buildFakes();
    await fakes.lifecycle.transition(business, makeAppointment("in_progress"), "completed");

    expect(fakes.cancelledReminders).toEqual(["a1"]);
    expect(fakes.tracked).toContain("appointment_completed");
    expect(fakes.emitted.map((e) => e.type)).toEqual(["appointment.completed"]);
    // Thank-you goes out on both channels (email + whatsapp-capable phone).
    const channels = fakes.sent.map((m) => m.channel).sort();
    expect(channels).toEqual(["email", "whatsapp"]);
    expect(fakes.sent[0].body).toContain("feedback");
  });

  it("no-show emits its event and stops reminders", async () => {
    const fakes = buildFakes();
    await fakes.lifecycle.transition(business, makeAppointment("confirmed"), "no_show");
    expect(fakes.emitted.map((e) => e.type)).toEqual(["appointment.no_show"]);
    expect(fakes.cancelledReminders).toEqual(["a1"]);
    expect(fakes.sent).toHaveLength(0); // no thank-you for a no-show
  });

  it("rejects illegal transitions", async () => {
    const fakes = buildFakes();
    await expect(
      fakes.lifecycle.transition(business, makeAppointment("completed"), "checked_in"),
    ).rejects.toThrow(/cannot move/i);
    expect(fakes.statusWrites).toHaveLength(0);
  });
});

describe("FeedbackService", () => {
  it("accepts a survey after the visit and emits feedback.received", async () => {
    const fakes = buildFakes();
    await fakes.feedback.submit(
      makeAppointment("completed"),
      { rating: 5, nps: 10, comment: "Fantastic" },
      NOW,
    );

    expect(fakes.feedbackRows).toEqual([
      { appointmentId: "a1", businessId: "b1", rating: 5, nps: 10, comment: "Fantastic" },
    ]);
    expect(fakes.tracked).toContain("feedback_received");
    expect(fakes.emitted[0].type).toBe("feedback.received");
    expect(fakes.emitted[0].payload.rating).toBe(5);
    expect(fakes.emitted[0].payload.visitorEmail).toBe("sam@example.com");
  });

  it("accepts feedback once the start time has passed, even if staff forgot to complete", async () => {
    const fakes = buildFakes();
    await expect(
      fakes.feedback.submit(makeAppointment("confirmed"), { rating: 4, comment: "" }, NOW),
    ).resolves.toBeUndefined();
  });

  it("rejects feedback before the visit and for cancelled appointments", async () => {
    const fakes = buildFakes();
    const future = makeAppointment("confirmed", "2026-07-20T13:00:00.000Z");
    await expect(
      fakes.feedback.submit(future, { rating: 5, comment: "" }, NOW),
    ).rejects.toThrow(/after your appointment/i);
    await expect(
      fakes.feedback.submit(makeAppointment("cancelled"), { rating: 5, comment: "" }, NOW),
    ).rejects.toThrow(/after your appointment/i);
    expect(fakes.feedbackRows).toHaveLength(0);
  });
});
