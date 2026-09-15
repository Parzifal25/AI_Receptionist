import "server-only";
import type { Business } from "@halo/core/domain/types";
import type {
  Appointment,
  AppointmentFeedback,
  SchedulingSettings,
  TimeSlot,
} from "@halo/core/domain/scheduling";
import { AppError } from "@halo/core/errors/app-error";
import { isLive } from "@halo/scheduling/appointment-state";
import { BookingService, type BookingResult } from "@halo/scheduling/booking-service";
import { SchedulingRepository } from "@halo/scheduling/scheduling-repository";
import { AppointmentLifecycleService } from "./lifecycle-service";
import { FeedbackService, type FeedbackInput } from "./feedback-service";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { logger } from "@halo/platform/logger";

const log = logger.child({ service: "appointment-manage" });

/** Everything the manage page/API needs about one appointment. */
export interface ManageContext {
  appointment: Appointment;
  business: Business;
  settings: SchedulingSettings;
  feedback: AppointmentFeedback | null;
  intakeAnswers: Record<string, string | boolean> | null;
  /** Whether the visitor can still reschedule/cancel. */
  isLive: boolean;
}

/**
 * Token-authenticated self-service over one appointment: the manage_token in
 * the link is the entire credential, so every operation resolves the
 * appointment ONLY through it and never accepts ids from the client.
 */
export class AppointmentManageService {
  constructor(
    private readonly repository: SchedulingRepository = new SchedulingRepository(),
    private readonly booking: BookingService = new BookingService(),
    private readonly lifecycle: AppointmentLifecycleService = new AppointmentLifecycleService(),
    private readonly feedbackService: FeedbackService = new FeedbackService(),
  ) {}

  async getContext(token: string): Promise<ManageContext | null> {
    const appointment = await this.repository.getAppointmentByToken(token);
    if (!appointment) return null;
    const business = await loadBusinessById(appointment.businessId);
    if (!business) return null;
    const [settings, feedback, intakeAnswers] = await Promise.all([
      this.repository.getSettings(appointment.businessId),
      this.repository.getFeedback(appointment.id),
      this.repository.getIntakeResponse(appointment.id),
    ]);
    return {
      appointment,
      business,
      settings,
      feedback,
      intakeAnswers,
      isLive: isLive(appointment.status),
    };
  }

  private async requireContext(token: string): Promise<ManageContext> {
    const context = await this.getContext(token);
    if (!context) throw AppError.notFound("Appointment");
    return context;
  }

  /** Open slots the visitor can move this appointment to. */
  async listRescheduleSlots(token: string, limit = 12): Promise<TimeSlot[]> {
    const { business, appointment } = await this.requireContext(token);
    if (!isLive(appointment.status)) return [];
    const { slots } = await this.booking.getAvailability({ business, limit });
    return slots;
  }

  async cancel(token: string, reason?: string): Promise<void> {
    const { business, appointment } = await this.requireContext(token);
    await this.booking.cancel({ business, appointment, reason });
  }

  /** Moves the appointment to a slot chosen from listRescheduleSlots. */
  async reschedule(token: string, startsAt: string, staffId: string): Promise<BookingResult> {
    const { business, appointment } = await this.requireContext(token);
    // Re-derive the slot server-side — the client only names a time, it
    // never dictates the range or bypasses availability rules.
    const { slots } = await this.booking.getAvailability({ business, limit: 100 });
    const slot = slots.find((s) => s.startsAt === startsAt && s.staffId === staffId);
    if (!slot) {
      return { ok: false, reason: "invalid", message: "That time is no longer available" };
    }
    return this.booking.reschedule({ business, appointment, slot });
  }

  /** Visitor self-service day-of updates. */
  async checkIn(token: string): Promise<Appointment> {
    const { business, appointment } = await this.requireContext(token);
    return this.lifecycle.transition(business, appointment, "checked_in");
  }

  async runningLate(token: string): Promise<Appointment> {
    const { business, appointment } = await this.requireContext(token);
    return this.lifecycle.transition(business, appointment, "running_late");
  }

  async submitFeedback(token: string, input: FeedbackInput): Promise<void> {
    const { appointment } = await this.requireContext(token);
    await this.feedbackService.submit(appointment, input);
  }

  /** Validates answers against the business's intake form, then stores them. */
  async submitIntake(token: string, answers: Record<string, unknown>): Promise<void> {
    const { appointment, settings } = await this.requireContext(token);
    if (settings.intakeForm.length === 0) {
      throw AppError.validation("This business has no intake form");
    }
    const clean: Record<string, string | boolean> = {};
    for (const field of settings.intakeForm) {
      const raw = answers[field.id];
      if (field.type === "checkbox") {
        clean[field.id] = raw === true || raw === "true" || raw === "on";
        continue;
      }
      const value = typeof raw === "string" ? raw.trim().slice(0, 4000) : "";
      if (field.required && !value) {
        throw AppError.validation(`"${field.label}" is required`);
      }
      clean[field.id] = value;
    }
    await this.repository.upsertIntakeResponse(appointment.id, appointment.businessId, clean);
  }
}

/** Hydrates the Business domain object lifecycle flows need. */
export async function loadBusinessById(businessId: string): Promise<Business | null> {
  const { data, error } = await getAdminClient()
    .from("businesses")
    .select("id, name, slug, description, industry, website, phone, email, address, business_hours, logo_url")
    .eq("id", businessId)
    .maybeSingle();
  if (error) {
    log.error("business lookup failed", { error: error.message });
    throw AppError.internal();
  }
  if (!data) return null;
  return {
    id: data.id,
    name: data.name,
    slug: data.slug,
    description: data.description,
    industry: data.industry,
    website: data.website,
    phone: data.phone,
    email: data.email,
    address: data.address,
    businessHours: data.business_hours ?? {},
    logoUrl: data.logo_url,
  };
}
