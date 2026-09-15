import type { AppointmentStatus } from "@halo/core/domain/scheduling";

/**
 * Lifecycle analytics: the business-health numbers derived from the customer
 * journey. `computeLifecycleMetrics` is pure — it takes plain counts and rows
 * so tests pin every formula; `LifecycleAnalyticsService` (see service.ts)
 * feeds it from Supabase.
 */

export interface LifecycleAnalyticsInput {
  /** usage_events counts by event_type within the period. */
  usageCounts: Record<string, number>;
  /** Appointments whose start falls in the period. */
  appointments: Array<{
    status: AppointmentStatus;
    startsAt: string;
    endsAt: string;
    timezone: string;
  }>;
  /** Live (unmerged) customers for the business, all-time. */
  customers: Array<{ totalAppointments: number; revenueTotal: number }>;
  /** Active bookable staff. */
  staffCount: number;
  periodDays: number;
}

export interface LifecycleMetrics {
  /** Appointments booked per conversation started. */
  bookingConversionRate: number | null;
  /** Reminders delivered per reminder attempted to completion. */
  reminderSuccessRate: number | null;
  /** No-shows per settled visit (completed + no-show). */
  noShowRate: number | null;
  /** Surveys/reviews received per completed appointment. */
  reviewRate: number | null;
  reviewRequests: number;
  feedbackReceived: number;
  /** Average all-time revenue per customer. */
  customerLifetimeValue: number | null;
  /** Customers with 2+ appointments per customer with 1+. */
  repeatCustomerRate: number | null;
  repeatCustomers: number;
  totalCustomers: number;
  /** Sum of revenue attributed to customers (all-time). */
  revenueTotal: number;
  /** Minutes of appointments booked in the period. */
  bookedMinutes: number;
  /**
   * Booked minutes per staff capacity, assuming an 8-hour bookable day.
   * A directional gauge, not a payroll number.
   */
  appointmentUtilization: number | null;
  /** Local start hour → bookings, sorted busiest first. */
  peakBookingHours: Array<{ hour: number; count: number }>;
  /** Messages answered without landing in "unanswered questions". */
  aiSuccessRate: number | null;
  /** Raw funnel counts for the dashboard. */
  counts: {
    conversations: number;
    booked: number;
    completed: number;
    cancelled: number;
    noShows: number;
    remindersSent: number;
    remindersFailed: number;
  };
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

/** Start hour in the appointment's own timezone (visitors book local time). */
export function localStartHour(startsAt: string, timezone: string): number {
  try {
    const hour = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      hour: "numeric",
      hour12: false,
    }).format(new Date(startsAt));
    return Number(hour) % 24;
  } catch {
    return new Date(startsAt).getUTCHours();
  }
}

export function computeLifecycleMetrics(input: LifecycleAnalyticsInput): LifecycleMetrics {
  const count = (type: string) => input.usageCounts[type] ?? 0;

  const conversations = count("conversation_started");
  const booked = count("appointment_booked");
  const remindersSent = count("reminder_sent");
  const remindersFailed = count("reminder_failed");
  const reviewRequests = count("review_requested");
  const feedbackReceived = count("feedback_received");
  const messages = count("message_sent");
  const unanswered = count("unanswered_question");

  const completed = input.appointments.filter((a) => a.status === "completed").length;
  const noShows = input.appointments.filter((a) => a.status === "no_show").length;
  const cancelled = input.appointments.filter((a) => a.status === "cancelled").length;

  const bookedMinutes = input.appointments
    .filter((a) => a.status !== "cancelled")
    .reduce((sum, a) => sum + Math.max(0, (Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60_000), 0);
  const capacityMinutes = input.staffCount * input.periodDays * 8 * 60;

  const hourHistogram = new Map<number, number>();
  for (const appointment of input.appointments) {
    if (appointment.status === "cancelled") continue;
    const hour = localStartHour(appointment.startsAt, appointment.timezone);
    hourHistogram.set(hour, (hourHistogram.get(hour) ?? 0) + 1);
  }
  const peakBookingHours = [...hourHistogram.entries()]
    .map(([hour, total]) => ({ hour, count: total }))
    .sort((a, b) => b.count - a.count || a.hour - b.hour);

  const totalCustomers = input.customers.filter((c) => c.totalAppointments > 0).length;
  const repeatCustomers = input.customers.filter((c) => c.totalAppointments >= 2).length;
  const revenueTotal = input.customers.reduce((sum, c) => sum + c.revenueTotal, 0);

  return {
    bookingConversionRate: ratio(booked, conversations),
    reminderSuccessRate: ratio(remindersSent, remindersSent + remindersFailed),
    noShowRate: ratio(noShows, completed + noShows),
    reviewRate: ratio(feedbackReceived, completed),
    reviewRequests,
    feedbackReceived,
    customerLifetimeValue: ratio(revenueTotal, input.customers.length),
    repeatCustomerRate: ratio(repeatCustomers, totalCustomers),
    repeatCustomers,
    totalCustomers,
    revenueTotal,
    bookedMinutes,
    appointmentUtilization: ratio(bookedMinutes, capacityMinutes),
    peakBookingHours,
    aiSuccessRate: messages > 0 ? Math.max(0, 1 - unanswered / messages) : null,
    counts: {
      conversations,
      booked,
      completed,
      cancelled,
      noShows,
      remindersSent,
      remindersFailed,
    },
  };
}
