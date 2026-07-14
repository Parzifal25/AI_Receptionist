import type { BusinessHours } from "./types";

/**
 * Scheduling domain. Appointments, staff, and the settings that drive slot
 * generation. Times are stored as UTC ISO strings; the business timezone
 * (IANA name) governs how working hours and holidays are interpreted and how
 * slots are presented to visitors.
 */

export type CalendarProviderKind = "internal" | "google" | "outlook" | "caldav";

export interface StaffMember {
  id: string;
  businessId: string;
  name: string;
  role: string;
  /** Per-staff working hours; null means "use the business hours". */
  workingHours: BusinessHours | null;
  isActive: boolean;
  calendarProvider: CalendarProviderKind;
  /** Provider-specific calendar identifier (calendar id, CalDAV URL, ...). */
  calendarRef: string;
}

export interface SchedulingSettings {
  businessId: string;
  bookingEnabled: boolean;
  /** IANA timezone the business operates in, e.g. "America/Chicago". */
  timezone: string;
  slotDurationMinutes: number;
  /** Idle time enforced before and after every appointment. */
  bufferMinutes: number;
  /** Earliest bookable moment, minutes from now. */
  minNoticeMinutes: number;
  /** How far into the future visitors may book. */
  maxAdvanceDays: number;
  /** Closed dates as YYYY-MM-DD strings in the business timezone. */
  holidays: string[];
  remindersEnabled: boolean;
  /** Lead times before the appointment when reminders fire, in minutes. */
  reminderLeadMinutes: number[];
  /** Street address for confirmations and Google Maps directions links. */
  locationAddress: string;
  /** "How to prepare" copy included in confirmations and reminders. */
  prepInstructions: string;
  /** Pre-visit intake form the visitor fills in from the manage page. */
  intakeForm: IntakeField[];
  /** Where "leave us a review" requests point (Google/Yelp/…). */
  reviewUrl: string;
}

/** One field of a business's pre-visit intake form. */
export interface IntakeField {
  /** Stable key answers are stored under. */
  id: string;
  label: string;
  type: "text" | "textarea" | "checkbox";
  required: boolean;
}

export const DEFAULT_SCHEDULING_SETTINGS: Omit<SchedulingSettings, "businessId"> = {
  bookingEnabled: false,
  timezone: "UTC",
  slotDurationMinutes: 30,
  bufferMinutes: 0,
  minNoticeMinutes: 120,
  maxAdvanceDays: 14,
  holidays: [],
  remindersEnabled: true,
  reminderLeadMinutes: [24 * 60, 60],
  locationAddress: "",
  prepInstructions: "",
  intakeForm: [],
  reviewUrl: "",
};

/** A UTC time range. `start` inclusive, `end` exclusive. */
export interface BusyInterval {
  start: string;
  end: string;
}

export interface TimeSlot {
  staffId: string;
  staffName: string;
  /** UTC ISO instants. */
  startsAt: string;
  endsAt: string;
}

export type AppointmentStatus =
  | "pending"
  | "confirmed"
  | "checked_in"
  | "running_late"
  | "in_progress"
  | "cancelled"
  | "completed"
  | "no_show";

export interface Appointment {
  id: string;
  businessId: string;
  staffId: string;
  conversationId: string | null;
  leadId: string | null;
  serviceName: string;
  visitorName: string;
  visitorPhone: string;
  visitorEmail: string;
  startsAt: string;
  endsAt: string;
  /** Timezone the appointment was booked in (for display/reminders). */
  timezone: string;
  status: AppointmentStatus;
  /** Event id in the external calendar, empty for internal-only. */
  externalEventId: string;
  /** Capability credential for self-service manage/feedback/intake links. */
  manageToken: string;
  notes: string;
  createdAt: string;
}

/** Post-appointment satisfaction survey / review feedback. */
export interface AppointmentFeedback {
  appointmentId: string;
  businessId: string;
  /** 1–5 stars. */
  rating: number;
  /** 0–10 "would you recommend us", optional. */
  nps: number | null;
  comment: string;
}

export interface AppointmentDraft {
  businessId: string;
  staffId: string;
  conversationId: string | null;
  serviceName: string;
  visitorName: string;
  visitorPhone: string;
  visitorEmail: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  notes?: string;
}

export type ReminderChannel = "sms" | "whatsapp" | "email";

export type ReminderStatus = "scheduled" | "sent" | "failed" | "cancelled";

export interface AppointmentReminder {
  id: number;
  appointmentId: string;
  businessId: string;
  channel: ReminderChannel;
  sendAt: string;
  status: ReminderStatus;
  attempts: number;
}
