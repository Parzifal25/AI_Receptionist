import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Appointment,
  AppointmentFeedback,
  AppointmentDraft,
  AppointmentReminder,
  AppointmentStatus,
  BusyInterval,
  IntakeField,
  ReminderChannel,
  SchedulingSettings,
  StaffMember,
} from "@halo/core/domain/scheduling";
import { DEFAULT_SCHEDULING_SETTINGS } from "@halo/core/domain/scheduling";
import type { LifecycleSettingsPatch } from "@halo/lifecycle/lifecycle-settings";
import type { BookingDraft } from "./booking-draft";
import { ACTIVE_STATUSES, SWEEPABLE_STATUSES } from "./appointment-state";
import type { CalendarConnection } from "@halo/providers/calendar/factory";
import { AppError } from "@halo/core/errors/app-error";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { logger } from "@halo/platform/logger";

const log = logger.child({ service: "scheduling-repository" });

/** Postgres exclusion-constraint violation — the double-booking signal. */
const EXCLUSION_VIOLATION = "23P01";

/** Typed "someone else just took that slot" error the AI can react to. */
export class SlotTakenError extends Error {
  constructor() {
    super("That time slot was just booked");
    this.name = "SlotTakenError";
  }
}

/**
 * All persistence for the scheduling engine. Service-role client; every
 * method takes explicit tenant scope. Double-booking is prevented by the
 * appointments_no_overlap exclusion constraint — inserts and time updates
 * translate that violation into SlotTakenError.
 */
export class SchedulingRepository {
  constructor(private readonly db: SupabaseClient = getAdminClient()) {}

  /** Settings with defaults applied; null bookingEnabled row = booking off. */
  async getSettings(businessId: string): Promise<SchedulingSettings> {
    const { data, error } = await this.db
      .from("scheduling_settings")
      .select(
        "booking_enabled, timezone, slot_duration_minutes, buffer_minutes, min_notice_minutes, max_advance_days, holidays, reminders_enabled, reminder_lead_minutes, location_address, prep_instructions, intake_form, review_url, auto_no_show_enabled, no_show_grace_minutes",
      )
      .eq("business_id", businessId)
      .maybeSingle();

    if (error) {
      log.error("scheduling settings lookup failed", { error: error.message });
      throw AppError.internal();
    }
    if (!data) return { businessId, ...DEFAULT_SCHEDULING_SETTINGS };
    return {
      businessId,
      bookingEnabled: data.booking_enabled,
      timezone: data.timezone,
      slotDurationMinutes: data.slot_duration_minutes,
      bufferMinutes: data.buffer_minutes,
      minNoticeMinutes: data.min_notice_minutes,
      maxAdvanceDays: data.max_advance_days,
      holidays: Array.isArray(data.holidays) ? data.holidays : [],
      remindersEnabled: data.reminders_enabled,
      reminderLeadMinutes: Array.isArray(data.reminder_lead_minutes)
        ? data.reminder_lead_minutes
        : [...DEFAULT_SCHEDULING_SETTINGS.reminderLeadMinutes],
      locationAddress: data.location_address ?? "",
      prepInstructions: data.prep_instructions ?? "",
      intakeForm: Array.isArray(data.intake_form) ? (data.intake_form as IntakeField[]) : [],
      reviewUrl: data.review_url ?? "",
      autoNoShowEnabled: data.auto_no_show_enabled ?? false,
      noShowGraceMinutes:
        data.no_show_grace_minutes ?? DEFAULT_SCHEDULING_SETTINGS.noShowGraceMinutes,
    };
  }

  /**
   * Writes the tenant-editable lifecycle settings. Upserts so a business
   * that has never opened the scheduling settings still gets a row, with the
   * booking-engine columns left at their defaults.
   */
  async updateLifecycleSettings(
    businessId: string,
    patch: LifecycleSettingsPatch,
  ): Promise<void> {
    const { error } = await this.db.from("scheduling_settings").upsert(
      {
        business_id: businessId,
        location_address: patch.locationAddress,
        prep_instructions: patch.prepInstructions,
        review_url: patch.reviewUrl,
        intake_form: patch.intakeForm,
        reminders_enabled: patch.remindersEnabled,
        reminder_lead_minutes: patch.reminderLeadMinutes,
        auto_no_show_enabled: patch.autoNoShowEnabled,
        no_show_grace_minutes: patch.noShowGraceMinutes,
      },
      { onConflict: "business_id" },
    );
    if (error) {
      log.error("lifecycle settings update failed", { error: error.message });
      throw AppError.internal();
    }
  }

  /**
   * Appointments the no-show sweep should consider: still live (nobody
   * checked them in or closed them out) and already over. Oldest first, so a
   * backlog of not-yet-past-grace rows can never starve genuinely overdue
   * ones out of the batch. Cross-tenant by design — the caller applies each
   * business's own grace period.
   */
  async listOverdueLiveAppointments(nowISO: string, limit = 100): Promise<Appointment[]> {
    const { data, error } = await this.db
      .from("appointments")
      .select("*")
      .in("status", SWEEPABLE_STATUSES)
      .lt("ends_at", nowISO)
      .order("ends_at", { ascending: true })
      .limit(limit);
    if (error) {
      log.error("overdue appointment lookup failed", { error: error.message });
      throw AppError.internal();
    }
    return (data ?? []).map(mapAppointment);
  }

  async listActiveStaff(businessId: string): Promise<StaffMember[]> {
    const { data, error } = await this.db
      .from("staff_members")
      .select("id, business_id, name, role, working_hours, is_active, calendar_provider, calendar_ref")
      .eq("business_id", businessId)
      .eq("is_active", true);

    if (error) {
      log.error("staff lookup failed", { error: error.message });
      throw AppError.internal();
    }
    return (data ?? []).map((row) => ({
      id: row.id,
      businessId: row.business_id,
      name: row.name,
      role: row.role,
      workingHours: row.working_hours ?? null,
      isActive: row.is_active,
      calendarProvider: row.calendar_provider,
      calendarRef: row.calendar_ref,
    }));
  }

  /** Live-appointment busy intervals per staff member within a window. */
  async listInternalBusy(
    businessId: string,
    fromISO: string,
    toISO: string,
  ): Promise<Map<string, BusyInterval[]>> {
    const { data, error } = await this.db
      .from("appointments")
      .select("staff_id, starts_at, ends_at")
      .eq("business_id", businessId)
      .in("status", ACTIVE_STATUSES)
      .lt("starts_at", toISO)
      .gt("ends_at", fromISO);

    if (error) {
      log.error("busy lookup failed", { error: error.message });
      throw AppError.internal();
    }
    const map = new Map<string, BusyInterval[]>();
    for (const row of data ?? []) {
      const list = map.get(row.staff_id) ?? [];
      list.push({ start: row.starts_at, end: row.ends_at });
      map.set(row.staff_id, list);
    }
    return map;
  }

  async insertAppointment(draft: AppointmentDraft, status: AppointmentStatus): Promise<Appointment> {
    const { data, error } = await this.db
      .from("appointments")
      .insert({
        business_id: draft.businessId,
        staff_id: draft.staffId,
        conversation_id: draft.conversationId,
        service_name: draft.serviceName.slice(0, 200),
        visitor_name: draft.visitorName.slice(0, 200),
        visitor_phone: draft.visitorPhone.slice(0, 50),
        visitor_email: draft.visitorEmail.slice(0, 200),
        starts_at: draft.startsAt,
        ends_at: draft.endsAt,
        timezone: draft.timezone,
        status,
        notes: (draft.notes ?? "").slice(0, 2000),
      })
      .select("*")
      .single();

    if (error) {
      if (error.code === EXCLUSION_VIOLATION) throw new SlotTakenError();
      log.error("appointment insert failed", { error: error.message });
      throw AppError.internal();
    }
    return mapAppointment(data);
  }

  async getAppointment(appointmentId: string): Promise<Appointment | null> {
    const { data, error } = await this.db
      .from("appointments")
      .select("*")
      .eq("id", appointmentId)
      .maybeSingle();
    if (error) {
      log.error("appointment lookup failed", { error: error.message });
      throw AppError.internal();
    }
    return data ? mapAppointment(data) : null;
  }

  /** The live appointment attached to a conversation, if any. */
  async findLiveAppointmentByConversation(conversationId: string): Promise<Appointment | null> {
    const { data, error } = await this.db
      .from("appointments")
      .select("*")
      .eq("conversation_id", conversationId)
      .in("status", ACTIVE_STATUSES)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      log.error("appointment-by-conversation lookup failed", { error: error.message });
      throw AppError.internal();
    }
    return data ? mapAppointment(data) : null;
  }

  async updateAppointmentStatus(
    appointmentId: string,
    status: AppointmentStatus,
    noteSuffix = "",
  ): Promise<void> {
    const current = await this.getAppointment(appointmentId);
    if (!current) throw AppError.notFound("Appointment");
    const { error } = await this.db
      .from("appointments")
      .update({
        status,
        notes: noteSuffix ? `${current.notes}\n${noteSuffix}`.trim().slice(0, 2000) : current.notes,
      })
      .eq("id", appointmentId);
    if (error) {
      log.error("appointment status update failed", { error: error.message });
      throw AppError.internal();
    }
  }

  /** Moves a live appointment; the exclusion constraint arbitrates races. */
  async updateAppointmentTimes(
    appointmentId: string,
    startsAt: string,
    endsAt: string,
    staffId: string,
    noteSuffix = "",
  ): Promise<void> {
    const current = await this.getAppointment(appointmentId);
    if (!current) throw AppError.notFound("Appointment");
    const { error } = await this.db
      .from("appointments")
      .update({
        starts_at: startsAt,
        ends_at: endsAt,
        staff_id: staffId,
        notes: noteSuffix ? `${current.notes}\n${noteSuffix}`.trim().slice(0, 2000) : current.notes,
      })
      .eq("id", appointmentId);
    if (error) {
      if (error.code === EXCLUSION_VIOLATION) throw new SlotTakenError();
      log.error("appointment reschedule failed", { error: error.message });
      throw AppError.internal();
    }
  }

  /** Token-scoped lookup for the public self-service manage surface. */
  async getAppointmentByToken(manageToken: string): Promise<Appointment | null> {
    const { data, error } = await this.db
      .from("appointments")
      .select("*")
      .eq("manage_token", manageToken)
      .maybeSingle();
    if (error) {
      log.error("appointment-by-token lookup failed", { error: error.message });
      throw AppError.internal();
    }
    return data ? mapAppointment(data) : null;
  }

  /** Appointments in a window for the dashboard day board. */
  async listAppointments(
    businessId: string,
    fromISO: string,
    toISO: string,
  ): Promise<Appointment[]> {
    const { data, error } = await this.db
      .from("appointments")
      .select("*")
      .eq("business_id", businessId)
      .gte("starts_at", fromISO)
      .lt("starts_at", toISO)
      .order("starts_at", { ascending: true });
    if (error) {
      log.error("appointment list failed", { error: error.message });
      throw AppError.internal();
    }
    return (data ?? []).map(mapAppointment);
  }

  async setExternalEventId(appointmentId: string, externalEventId: string): Promise<void> {
    const { error } = await this.db
      .from("appointments")
      .update({ external_event_id: externalEventId })
      .eq("id", appointmentId);
    if (error) log.warn("external event id update failed", { error: error.message });
  }

  // --- Booking drafts ---------------------------------------------------------

  /**
   * The half-finished appointment a conversation is assembling, if any.
   * A lookup failure degrades to "no draft yet" rather than breaking the
   * chat turn — the conversation re-gathers instead of 500-ing.
   */
  async getBookingDraft(conversationId: string): Promise<BookingDraft | null> {
    const { data, error } = await this.db
      .from("booking_drafts")
      .select(
        "service, draft_date, draft_time, visitor_name, visitor_email, visitor_phone, notes, time_committed",
      )
      .eq("conversation_id", conversationId)
      .maybeSingle();

    if (error) {
      log.warn("booking draft lookup failed", { error: error.message });
      return null;
    }
    if (!data) return null;
    return {
      service: data.service,
      date: data.draft_date,
      time: data.draft_time,
      name: data.visitor_name,
      email: data.visitor_email,
      phone: data.visitor_phone,
      notes: data.notes,
      timeCommitted: data.time_committed,
    };
  }

  /** Upserts the draft; failures are logged, never thrown. */
  async saveBookingDraft(
    businessId: string,
    conversationId: string,
    draft: BookingDraft,
  ): Promise<void> {
    const { error } = await this.db.from("booking_drafts").upsert(
      {
        conversation_id: conversationId,
        business_id: businessId,
        service: draft.service.slice(0, 200),
        draft_date: draft.date.slice(0, 10),
        draft_time: draft.time.slice(0, 5),
        visitor_name: draft.name.slice(0, 200),
        visitor_email: draft.email.slice(0, 200),
        visitor_phone: draft.phone.slice(0, 50),
        notes: draft.notes.slice(0, 2000),
        time_committed: draft.timeCommitted,
      },
      { onConflict: "conversation_id" },
    );
    if (error) log.warn("booking draft save failed", { error: error.message });
  }

  /** Drops the draft once it has become a real appointment (or was abandoned). */
  async clearBookingDraft(conversationId: string): Promise<void> {
    const { error } = await this.db
      .from("booking_drafts")
      .delete()
      .eq("conversation_id", conversationId);
    if (error) log.warn("booking draft clear failed", { error: error.message });
  }

  // --- Reminders ------------------------------------------------------------

  async scheduleReminders(
    rows: Array<{
      appointmentId: string;
      businessId: string;
      channel: ReminderChannel;
      sendAt: string;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.db.from("appointment_reminders").insert(
      rows.map((r) => ({
        appointment_id: r.appointmentId,
        business_id: r.businessId,
        channel: r.channel,
        send_at: r.sendAt,
      })),
    );
    if (error) {
      // Reminders are best-effort — never fail a booking over them.
      log.warn("reminder scheduling failed", { error: error.message });
    }
  }

  async cancelReminders(appointmentId: string): Promise<void> {
    const { error } = await this.db
      .from("appointment_reminders")
      .update({ status: "cancelled" })
      .eq("appointment_id", appointmentId)
      .eq("status", "scheduled");
    if (error) log.warn("reminder cancellation failed", { error: error.message });
  }

  /**
   * Claims due reminders via SKIP LOCKED. Claimed rows arrive marked
   * 'failed' with attempts bumped — pessimistic claiming means a crashed
   * worker can never double-send; the caller marks 'sent' on success or
   * requeues while attempts remain.
   */
  async claimDueReminders(batchSize = 25): Promise<AppointmentReminder[]> {
    const { data, error } = await this.db.rpc("claim_due_reminders", { batch_size: batchSize });
    if (error) {
      log.error("reminder claim failed", { error: error.message });
      throw AppError.internal();
    }
    return (data ?? []).map(
      (row: {
        id: number;
        appointment_id: string;
        business_id: string;
        channel: ReminderChannel;
        send_at: string;
        status: string;
        attempts: number;
      }) => ({
        id: row.id,
        appointmentId: row.appointment_id,
        businessId: row.business_id,
        channel: row.channel,
        sendAt: row.send_at,
        status: row.status as AppointmentReminder["status"],
        attempts: row.attempts,
      }),
    );
  }

  async markReminderSent(id: number): Promise<void> {
    const { error } = await this.db
      .from("appointment_reminders")
      .update({ status: "sent" })
      .eq("id", id);
    if (error) log.warn("reminder sent-mark failed", { error: error.message });
  }

  /** Requeues a failed delivery with backoff, or leaves it failed with the error. */
  async requeueReminder(id: number, sendAt: string, lastError: string): Promise<void> {
    const { error } = await this.db
      .from("appointment_reminders")
      .update({ status: "scheduled", send_at: sendAt, last_error: lastError.slice(0, 500) })
      .eq("id", id);
    if (error) log.warn("reminder requeue failed", { error: error.message });
  }

  async recordReminderError(id: number, lastError: string): Promise<void> {
    const { error } = await this.db
      .from("appointment_reminders")
      .update({ last_error: lastError.slice(0, 500) })
      .eq("id", id);
    if (error) log.warn("reminder error-record failed", { error: error.message });
  }

  // --- Feedback & intake ------------------------------------------------------

  /** Insert-or-update: resubmitting the survey revises the earlier answer. */
  async upsertFeedback(feedback: AppointmentFeedback): Promise<void> {
    const { error } = await this.db.from("appointment_feedback").upsert(
      {
        appointment_id: feedback.appointmentId,
        business_id: feedback.businessId,
        rating: feedback.rating,
        nps: feedback.nps,
        comment: feedback.comment.slice(0, 2000),
      },
      { onConflict: "appointment_id" },
    );
    if (error) {
      log.error("feedback upsert failed", { error: error.message });
      throw AppError.internal();
    }
  }

  async getFeedback(appointmentId: string): Promise<AppointmentFeedback | null> {
    const { data, error } = await this.db
      .from("appointment_feedback")
      .select("appointment_id, business_id, rating, nps, comment")
      .eq("appointment_id", appointmentId)
      .maybeSingle();
    if (error) {
      log.error("feedback lookup failed", { error: error.message });
      throw AppError.internal();
    }
    if (!data) return null;
    return {
      appointmentId: data.appointment_id,
      businessId: data.business_id,
      rating: data.rating,
      nps: data.nps,
      comment: data.comment,
    };
  }

  async upsertIntakeResponse(
    appointmentId: string,
    businessId: string,
    answers: Record<string, string | boolean>,
  ): Promise<void> {
    const { error } = await this.db.from("intake_responses").upsert(
      { appointment_id: appointmentId, business_id: businessId, answers },
      { onConflict: "appointment_id" },
    );
    if (error) {
      log.error("intake upsert failed", { error: error.message });
      throw AppError.internal();
    }
  }

  async getIntakeResponse(
    appointmentId: string,
  ): Promise<Record<string, string | boolean> | null> {
    const { data, error } = await this.db
      .from("intake_responses")
      .select("answers")
      .eq("appointment_id", appointmentId)
      .maybeSingle();
    if (error) {
      log.error("intake lookup failed", { error: error.message });
      throw AppError.internal();
    }
    return data ? (data.answers as Record<string, string | boolean>) : null;
  }

  // --- Calendar connections ---------------------------------------------------

  /** The connection for a staff member (falls back to the business-level one). */
  async getCalendarConnection(
    businessId: string,
    staffId: string,
  ): Promise<CalendarConnection | null> {
    const { data, error } = await this.db
      .from("calendar_connections")
      .select("id, provider, calendar_ref, access_token, refresh_token, expires_at, basic_username, basic_password, staff_id")
      .eq("business_id", businessId)
      .or(`staff_id.eq.${staffId},staff_id.is.null`)
      .order("staff_id", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      log.warn("calendar connection lookup failed", { error: error.message });
      return null;
    }
    if (!data) return null;

    const connectionId = data.id;
    return {
      provider: data.provider,
      calendarRef: data.calendar_ref,
      oauth:
        data.provider === "caldav"
          ? undefined
          : {
              accessToken: data.access_token,
              refreshToken: data.refresh_token,
              expiresAt: data.expires_at ?? "",
            },
      basicAuth:
        data.provider === "caldav"
          ? { username: data.basic_username, password: data.basic_password }
          : undefined,
      onTokenRotate: async (tokens) => {
        await this.db
          .from("calendar_connections")
          .update({
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            expires_at: tokens.expiresAt,
          })
          .eq("id", connectionId);
      },
    };
  }

  /** Fire-and-forget analytics, mirroring WidgetRepository.trackEvent. */
  async trackEvent(
    businessId: string,
    eventType:
      | "appointment_booked"
      | "appointment_rescheduled"
      | "appointment_cancelled"
      | "appointment_checked_in"
      | "appointment_completed"
      | "appointment_no_show"
      | "reminder_sent"
      | "reminder_failed"
      | "review_requested"
      | "feedback_received",
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const { error } = await this.db.from("usage_events").insert({
      business_id: businessId,
      event_type: eventType,
      metadata,
    });
    if (error) log.warn("usage event insert failed", { error: error.message });
  }
}

function mapAppointment(row: {
  id: string;
  business_id: string;
  staff_id: string;
  conversation_id: string | null;
  lead_id: string | null;
  service_name: string;
  visitor_name: string;
  visitor_phone: string;
  visitor_email: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  status: string;
  external_event_id: string;
  manage_token: string;
  notes: string;
  created_at: string;
}): Appointment {
  return {
    id: row.id,
    businessId: row.business_id,
    staffId: row.staff_id,
    conversationId: row.conversation_id,
    leadId: row.lead_id,
    serviceName: row.service_name,
    visitorName: row.visitor_name,
    visitorPhone: row.visitor_phone,
    visitorEmail: row.visitor_email,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    status: row.status as Appointment["status"],
    externalEventId: row.external_event_id,
    manageToken: row.manage_token,
    notes: row.notes,
    createdAt: row.created_at,
  };
}
