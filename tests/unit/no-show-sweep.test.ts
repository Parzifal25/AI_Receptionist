import { describe, expect, it } from "vitest";
import type { Appointment, AppointmentStatus } from "@halo/core/domain/scheduling";
import { isNoShowOverdue } from "@halo/lifecycle/no-show-sweep";

/**
 * The automatic no-show rule. Getting this wrong either marks paying
 * customers absent or leaves the recovery journey silent, so every branch
 * is pinned here rather than inferred from a cron run.
 */

const ENDS_AT = "2026-07-14T14:00:00.000Z";
const on = { autoNoShowEnabled: true, noShowGraceMinutes: 30 };

function appointment(status: AppointmentStatus, endsAt = ENDS_AT): Appointment {
  return {
    id: "a1",
    businessId: "b1",
    staffId: "s1",
    conversationId: null,
    leadId: null,
    serviceName: "AC tune-up",
    visitorName: "Ada",
    visitorPhone: "",
    visitorEmail: "ada@example.com",
    startsAt: "2026-07-14T13:00:00.000Z",
    endsAt,
    timezone: "America/New_York",
    status,
    externalEventId: "",
    manageToken: "tok",
    notes: "",
    createdAt: "2026-07-10T00:00:00.000Z",
  };
}

const at = (iso: string) => new Date(iso);

describe("isNoShowOverdue", () => {
  it("sweeps a confirmed appointment once the grace period has elapsed", () => {
    expect(isNoShowOverdue(appointment("confirmed"), on, at("2026-07-14T14:30:00Z"))).toBe(true);
    expect(isNoShowOverdue(appointment("confirmed"), on, at("2026-07-14T18:00:00Z"))).toBe(true);
  });

  it("waits out the grace period, measured from the END of the appointment", () => {
    // Over, but only just — the visitor may still be walking in.
    expect(isNoShowOverdue(appointment("confirmed"), on, at("2026-07-14T14:01:00Z"))).toBe(false);
    // One minute short of grace.
    expect(isNoShowOverdue(appointment("confirmed"), on, at("2026-07-14T14:29:00Z"))).toBe(false);
    // Exactly at the boundary counts as overdue.
    expect(isNoShowOverdue(appointment("confirmed"), on, at("2026-07-14T14:30:00Z"))).toBe(true);
  });

  it("never sweeps an appointment that has not finished yet", () => {
    expect(isNoShowOverdue(appointment("confirmed"), on, at("2026-07-14T13:30:00Z"))).toBe(false);
  });

  it("is opt-in — an untoggled business is never swept", () => {
    const off = { autoNoShowEnabled: false, noShowGraceMinutes: 30 };
    expect(isNoShowOverdue(appointment("confirmed"), off, at("2026-07-15T00:00:00Z"))).toBe(false);
  });

  it("sweeps pending and running_late, which also mean 'never arrived'", () => {
    const later = at("2026-07-14T16:00:00Z");
    expect(isNoShowOverdue(appointment("pending"), on, later)).toBe(true);
    expect(isNoShowOverdue(appointment("running_late"), on, later)).toBe(true);
  });

  it("never sweeps a visitor who demonstrably showed up", () => {
    const later = at("2026-07-15T00:00:00Z");
    expect(isNoShowOverdue(appointment("checked_in"), on, later)).toBe(false);
    expect(isNoShowOverdue(appointment("in_progress"), on, later)).toBe(false);
  });

  it("never re-sweeps a settled appointment", () => {
    const later = at("2026-07-15T00:00:00Z");
    for (const status of ["completed", "cancelled", "no_show"] as const) {
      expect(isNoShowOverdue(appointment(status), on, later)).toBe(false);
    }
  });

  it("treats zero grace as 'the moment it ends'", () => {
    const zero = { autoNoShowEnabled: true, noShowGraceMinutes: 0 };
    expect(isNoShowOverdue(appointment("confirmed"), zero, at("2026-07-14T14:00:00Z"))).toBe(true);
    expect(isNoShowOverdue(appointment("confirmed"), zero, at("2026-07-14T13:59:00Z"))).toBe(false);
  });

  it("ignores an unparseable end time instead of sweeping it", () => {
    expect(isNoShowOverdue(appointment("confirmed", "not-a-date"), on, at("2026-07-20T00:00:00Z"))).toBe(
      false,
    );
  });
});
