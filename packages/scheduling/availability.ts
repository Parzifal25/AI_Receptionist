import type { BusinessHours } from "@halo/core/domain/types";
import type {
  BusyInterval,
  SchedulingSettings,
  StaffMember,
  TimeSlot,
} from "@halo/core/domain/scheduling";
import {
  addDays,
  dateStringInTz,
  hourInTz,
  weekdayInTz,
  zonedTimeToUtc,
} from "./timezone";

/**
 * Availability engine. Pure: working hours + policy + busy intervals in,
 * bookable slots out. All conflict math happens on UTC epoch milliseconds;
 * working hours and holidays are interpreted in the business timezone, so
 * DST transitions shift slots with the wall clock like a human calendar.
 */

export interface AvailabilityInput {
  settings: SchedulingSettings;
  /** Fallback working hours when a staff member has none of their own. */
  businessHours: BusinessHours;
  staff: StaffMember[];
  /** Busy time per staff id (existing appointments + external calendars). */
  busyByStaff: Map<string, BusyInterval[]>;
  /** Search window (UTC). Clamped to [now + minNotice, now + maxAdvance]. */
  fromISO: string;
  toISO: string;
  now?: Date;
  /** Restrict slot starts to a local-time-of-day window (e.g. mornings). */
  localHourRange?: { startHour: number; endHour: number };
  /** Cap on returned slots, after merging staff. */
  limit?: number;
}

interface Interval {
  start: number;
  end: number;
}

function parseBusy(busy: BusyInterval[], bufferMs: number): Interval[] {
  return busy
    .map((b) => ({
      start: Date.parse(b.start) - bufferMs,
      end: Date.parse(b.end) + bufferMs,
    }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end))
    .sort((a, b) => a.start - b.start);
}

function overlapsAny(start: number, end: number, busy: Interval[]): boolean {
  for (const b of busy) {
    if (b.start >= end) break; // sorted — nothing later can overlap
    if (b.end > start) return true;
  }
  return false;
}

/**
 * Generates open slots for every active staff member, merged and sorted by
 * time. When several staff are free at the same instant the slot is emitted
 * once, assigned round-robin so bookings spread across the team.
 */
export function generateSlots(input: AvailabilityInput): TimeSlot[] {
  const {
    settings,
    businessHours,
    staff,
    busyByStaff,
    localHourRange,
    limit = 100,
  } = input;
  const now = input.now ?? new Date();
  const slotMs = settings.slotDurationMinutes * 60_000;
  const bufferMs = settings.bufferMinutes * 60_000;
  const tz = settings.timezone;

  const earliest = Math.max(
    Date.parse(input.fromISO),
    now.getTime() + settings.minNoticeMinutes * 60_000,
  );
  const latest = Math.min(
    Date.parse(input.toISO),
    now.getTime() + settings.maxAdvanceDays * 86_400_000,
  );
  if (!Number.isFinite(earliest) || !Number.isFinite(latest) || earliest >= latest) return [];

  const holidays = new Set(settings.holidays);
  const activeStaff = staff.filter((s) => s.isActive);
  if (activeStaff.length === 0) return [];

  const busyParsed = new Map<string, Interval[]>();
  for (const s of activeStaff) {
    busyParsed.set(s.id, parseBusy(busyByStaff.get(s.id) ?? [], bufferMs));
  }

  // Group per-instant so identical times across staff merge into one slot.
  const byStart = new Map<number, StaffMember[]>();

  // Iterate calendar days of the window in the business timezone.
  let day = dateStringInTz(new Date(earliest), tz);
  const lastDay = dateStringInTz(new Date(latest), tz);
  while (day <= lastDay) {
    if (!holidays.has(day)) {
      const [y, m, d] = day.split("-").map(Number);
      const dayAnchor = zonedTimeToUtc(tz, y, m, d, 12);
      const weekday = weekdayInTz(dayAnchor, tz);

      for (const member of activeStaff) {
        const hours = member.workingHours ?? businessHours;
        const entry = hours[weekday];
        if (!entry || entry.closed) continue;
        const [openH, openM] = entry.open.split(":").map(Number);
        const [closeH, closeM] = entry.close.split(":").map(Number);
        if ([openH, openM, closeH, closeM].some((n) => !Number.isFinite(n))) continue;

        const open = zonedTimeToUtc(tz, y, m, d, openH, openM).getTime();
        const close = zonedTimeToUtc(tz, y, m, d, closeH, closeM).getTime();
        const busy = busyParsed.get(member.id) ?? [];

        for (let start = open; start + slotMs <= close; start += slotMs) {
          if (start < earliest || start + slotMs > latest) continue;
          if (localHourRange) {
            const localHour = hourInTz(new Date(start), tz);
            if (localHour < localHourRange.startHour || localHour >= localHourRange.endHour) {
              continue;
            }
          }
          if (overlapsAny(start, start + slotMs, busy)) continue;
          const list = byStart.get(start) ?? [];
          list.push(member);
          byStart.set(start, list);
        }
      }
    }
    day = addDays(day, 1);
  }

  const starts = [...byStart.keys()].sort((a, b) => a - b);
  const slots: TimeSlot[] = [];
  let rr = 0;
  for (const start of starts) {
    if (slots.length >= limit) break;
    const candidates = byStart.get(start)!;
    const member = candidates[rr % candidates.length];
    rr += 1;
    slots.push({
      staffId: member.id,
      staffName: member.name,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(start + slotMs).toISOString(),
    });
  }
  return slots;
}

/**
 * Re-checks a single proposed slot against the same rules — the last line of
 * validation before an insert (the DB exclusion constraint is the final
 * arbiter under races).
 */
export function isSlotAvailable(
  input: Omit<AvailabilityInput, "fromISO" | "toISO" | "limit" | "localHourRange"> & {
    staffId: string;
    startsAt: string;
    endsAt: string;
  },
): boolean {
  const slots = generateSlots({
    ...input,
    staff: input.staff.filter((s) => s.id === input.staffId),
    fromISO: input.startsAt,
    toISO: input.endsAt,
    limit: 5,
  });
  return slots.some((s) => s.startsAt === input.startsAt && s.staffId === input.staffId);
}
