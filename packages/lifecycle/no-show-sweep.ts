import "server-only";
import type { Business } from "@halo/core/domain/types";
import type { Appointment, SchedulingSettings } from "@halo/core/domain/scheduling";
import { SWEEPABLE_STATUSES } from "@halo/scheduling/appointment-state";
import { SchedulingRepository } from "@halo/scheduling/scheduling-repository";
import { AppointmentLifecycleService } from "./lifecycle-service";
import { loadBusinessById } from "./manage-service";
import { logger } from "@halo/platform/logger";

const log = logger.child({ service: "no-show-sweep" });

/**
 * Decides whether one appointment is a no-show. Pure so the rule is pinned
 * by unit tests rather than inferred from a cron run.
 *
 * An appointment is swept when the business opted in, the visitor never
 * arrived (pending / confirmed / running_late — never checked_in or
 * in_progress), and the grace period measured from the appointment's END
 * has elapsed. Measuring from the end means a visit that ran long is never
 * swept out from under the staff working it.
 */
export function isNoShowOverdue(
  appointment: Appointment,
  settings: Pick<SchedulingSettings, "autoNoShowEnabled" | "noShowGraceMinutes">,
  now: Date,
): boolean {
  if (!settings.autoNoShowEnabled) return false;
  if (!SWEEPABLE_STATUSES.includes(appointment.status)) return false;

  const endsAt = Date.parse(appointment.endsAt);
  if (!Number.isFinite(endsAt)) return false;

  const graceMs = Math.max(0, settings.noShowGraceMinutes) * 60_000;
  return now.getTime() >= endsAt + graceMs;
}

/**
 * A type alias, not an interface: interfaces have no implicit index
 * signature, so an interface cannot be handed straight to the logger.
 */
export type SweepResult = {
  /** Appointments flipped to no_show. */
  sweptCount: number;
  /** Scanned but still inside their grace period, or tenant opted out. */
  skipped: number;
  /** Transitions that threw (a raced status change, a missing business). */
  failed: number;
};

/**
 * Closes out appointments nobody ever showed up for. Runs on the cron
 * heartbeat: every swept appointment goes through the normal lifecycle
 * transition, so it cancels pending reminders, records the analytics event,
 * and emits `appointment.no_show` — which is what feeds the no-show recovery
 * journey without any staff input.
 *
 * One failure never stops the batch: a raced transition (staff completed the
 * visit a second earlier) is expected and simply skips that row.
 */
export class NoShowSweepService {
  private readonly lifecycle: AppointmentLifecycleService;

  constructor(
    private readonly repository: SchedulingRepository = new SchedulingRepository(),
    lifecycle?: AppointmentLifecycleService,
    private readonly loadBusiness: (id: string) => Promise<Business | null> = loadBusinessById,
  ) {
    this.lifecycle = lifecycle ?? new AppointmentLifecycleService(repository);
  }

  async sweep(batchSize = 100, now = new Date()): Promise<SweepResult> {
    const candidates = await this.repository.listOverdueLiveAppointments(
      now.toISOString(),
      batchSize,
    );

    const result: SweepResult = { sweptCount: 0, skipped: 0, failed: 0 };
    if (candidates.length === 0) return result;

    // Settings and businesses repeat heavily within a batch; resolve once.
    const settingsCache = new Map<string, SchedulingSettings>();
    const businessCache = new Map<string, Business | null>();

    for (const appointment of candidates) {
      let settings = settingsCache.get(appointment.businessId);
      if (!settings) {
        settings = await this.repository.getSettings(appointment.businessId);
        settingsCache.set(appointment.businessId, settings);
      }

      if (!isNoShowOverdue(appointment, settings, now)) {
        result.skipped += 1;
        continue;
      }

      let business = businessCache.get(appointment.businessId);
      if (business === undefined) {
        business = await this.loadBusiness(appointment.businessId);
        businessCache.set(appointment.businessId, business);
      }
      if (!business) {
        result.failed += 1;
        continue;
      }

      try {
        await this.lifecycle.transition(business, appointment, "no_show");
        result.sweptCount += 1;
      } catch (error) {
        // Almost always a legal-transition conflict: staff closed the
        // appointment out between the scan and the write. Not an incident.
        result.failed += 1;
        log.info("no-show sweep skipped an appointment", {
          appointmentId: appointment.id,
          status: appointment.status,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }
}
