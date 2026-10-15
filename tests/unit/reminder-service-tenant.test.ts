import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULING_SETTINGS } from "@halo/core/domain/scheduling";
import type { MessagingProvider } from "@halo/ports/messaging-provider";
import { ReminderService } from "@halo/scheduling/reminder-service";
import type { SchedulingRepository } from "@halo/scheduling/scheduling-repository";

/**
 * Phase 2, Workstream 1 — the reminder job runs across tenants and rebuilds
 * each delivery from two rows: the claimed reminder (its tenant picks the
 * settings and analytics) and the appointment it names (the visitor and the
 * message). If they disagree, one tenant's settings would message another
 * tenant's visitor. 0034 refuses such rows; older ones must still not send.
 */
function harness(reminderTenant: string, appointmentTenant: string) {
  const sent: unknown[] = [];
  const errors: Array<[number, string]> = [];
  const repository = {
    claimDueReminders: async () => [{ id: 1, appointmentId: "appt-1", businessId: reminderTenant, channel: "sms", sendAt: "2031-01-01T09:00:00Z", status: "failed", attempts: 1 }],
    getAppointment: async () => ({
      id: "appt-1", businessId: appointmentTenant, staffId: "staff-1", conversationId: null, leadId: null, serviceName: "Visit",
      visitorName: "Synthetic Visitor", visitorPhone: "+15550000000", visitorEmail: "", startsAt: "2031-01-01T10:00:00Z",
      endsAt: "2031-01-01T11:00:00Z", timezone: "UTC", status: "confirmed", externalEventId: "", manageToken: "token-1", notes: "", createdAt: "",
    }),
    getSettings: async (businessId: string) => ({ businessId, ...DEFAULT_SCHEDULING_SETTINGS }),
    markReminderSent: async () => undefined,
    recordReminderError: async (id: number, message: string) => { errors.push([id, message]); },
    requeueReminder: async () => undefined,
    trackEvent: async () => undefined,
  } as unknown as SchedulingRepository;
  const messaging = { supports: () => true, send: async (message: unknown) => { sent.push(message); } } as unknown as MessagingProvider;
  return { service: new ReminderService(repository, messaging, "http://localhost:3000"), sent, errors };
}

describe("ReminderService keeps each delivery within one tenant", () => {
  it("never sends a reminder whose appointment belongs to another tenant", async () => {
    const { service, sent, errors } = harness("tenant-a", "tenant-b");
    expect(await service.processDue(25, new Date("2031-01-01T08:00:00Z"))).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(sent).toEqual([]);
    expect(errors).toEqual([[1, "reminder and appointment belong to different tenants"]]);
  });

  it("sends a reminder whose appointment belongs to the same tenant", async () => {
    const { service, sent } = harness("tenant-a", "tenant-a");
    expect(await service.processDue(25, new Date("2031-01-01T08:00:00Z"))).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(sent).toHaveLength(1);
  });
});
