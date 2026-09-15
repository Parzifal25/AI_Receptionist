import { describe, expect, it } from "vitest";
import {
  computeLifecycleMetrics,
  localStartHour,
  type LifecycleAnalyticsInput,
} from "@halo/analytics/lifecycle-analytics";

const appointment = (
  status: LifecycleAnalyticsInput["appointments"][number]["status"],
  startsAt: string,
  minutes = 60,
) => ({
  status,
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + minutes * 60_000).toISOString(),
  timezone: "America/New_York",
});

const input: LifecycleAnalyticsInput = {
  usageCounts: {
    conversation_started: 40,
    appointment_booked: 10,
    reminder_sent: 8,
    reminder_failed: 2,
    review_requested: 5,
    feedback_received: 3,
    message_sent: 200,
    unanswered_question: 10,
  },
  appointments: [
    appointment("completed", "2026-07-14T13:00:00.000Z"), // 9am ET
    appointment("completed", "2026-07-15T13:00:00.000Z"), // 9am ET
    appointment("completed", "2026-07-15T18:00:00.000Z"), // 2pm ET
    appointment("no_show", "2026-07-16T13:00:00.000Z"), // 9am ET
    appointment("cancelled", "2026-07-16T15:00:00.000Z"),
    appointment("confirmed", "2026-07-17T13:00:00.000Z"),
  ],
  customers: [
    { totalAppointments: 3, revenueTotal: 300 },
    { totalAppointments: 1, revenueTotal: 100 },
    { totalAppointments: 0, revenueTotal: 0 },
    { totalAppointments: 2, revenueTotal: 0 },
  ],
  staffCount: 2,
  periodDays: 30,
};

describe("localStartHour", () => {
  it("uses the appointment's own timezone", () => {
    expect(localStartHour("2026-07-14T13:00:00.000Z", "America/New_York")).toBe(9);
    expect(localStartHour("2026-07-14T13:00:00.000Z", "UTC")).toBe(13);
  });

  it("falls back to UTC on a bad timezone", () => {
    expect(localStartHour("2026-07-14T13:00:00.000Z", "Not/AZone")).toBe(13);
  });
});

describe("computeLifecycleMetrics", () => {
  const metrics = computeLifecycleMetrics(input);

  it("computes the funnel and delivery rates", () => {
    expect(metrics.bookingConversionRate).toBeCloseTo(10 / 40);
    expect(metrics.reminderSuccessRate).toBeCloseTo(8 / 10);
    expect(metrics.noShowRate).toBeCloseTo(1 / 4); // 1 no-show vs 3 completed
    expect(metrics.reviewRate).toBeCloseTo(3 / 3);
    expect(metrics.aiSuccessRate).toBeCloseTo(1 - 10 / 200);
  });

  it("computes customer value and loyalty", () => {
    expect(metrics.revenueTotal).toBe(400);
    expect(metrics.customerLifetimeValue).toBeCloseTo(400 / 4);
    expect(metrics.totalCustomers).toBe(3); // customers with ≥1 appointment
    expect(metrics.repeatCustomers).toBe(2);
    expect(metrics.repeatCustomerRate).toBeCloseTo(2 / 3);
  });

  it("computes utilization from booked minutes vs 8h staff days", () => {
    // 5 non-cancelled appointments × 60 min.
    expect(metrics.bookedMinutes).toBe(300);
    expect(metrics.appointmentUtilization).toBeCloseTo(300 / (2 * 30 * 480));
  });

  it("ranks peak booking hours in local time, busiest first", () => {
    expect(metrics.peakBookingHours[0]).toEqual({ hour: 9, count: 4 });
    expect(metrics.peakBookingHours).toContainEqual({ hour: 14, count: 1 });
    // Cancelled bookings don't shape the histogram.
    expect(metrics.peakBookingHours.find((h) => h.hour === 11)).toBeUndefined();
  });

  it("returns null rates instead of dividing by zero", () => {
    const empty = computeLifecycleMetrics({
      usageCounts: {},
      appointments: [],
      customers: [],
      staffCount: 0,
      periodDays: 30,
    });
    expect(empty.bookingConversionRate).toBeNull();
    expect(empty.reminderSuccessRate).toBeNull();
    expect(empty.noShowRate).toBeNull();
    expect(empty.reviewRate).toBeNull();
    expect(empty.customerLifetimeValue).toBeNull();
    expect(empty.repeatCustomerRate).toBeNull();
    expect(empty.appointmentUtilization).toBeNull();
    expect(empty.aiSuccessRate).toBeNull();
  });
});
