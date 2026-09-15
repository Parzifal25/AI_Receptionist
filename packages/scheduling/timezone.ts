/**
 * Timezone arithmetic on top of the Intl API — no date library dependency.
 * All functions are pure. IANA zone names in, UTC `Date`s out.
 */

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let dtf = partsCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(timeZone, dtf);
  }
  return dtf;
}

function wallClockParts(utc: Date, timeZone: string) {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(utc)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl reports midnight as "24" in some ICU versions.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The zone's UTC offset (ms) at a given instant. */
export function timezoneOffsetMs(utc: Date, timeZone: string): number {
  const p = wallClockParts(utc, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utc.getTime() / 1000) * 1000;
}

/**
 * Converts a wall-clock time in a zone to the UTC instant. Two-pass offset
 * resolution handles DST edges: nonexistent local times resolve to the
 * post-transition instant, ambiguous ones to the first occurrence.
 */
export function zonedTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let offset = timezoneOffsetMs(new Date(naive), timeZone);
  offset = timezoneOffsetMs(new Date(naive - offset), timeZone);
  return new Date(naive - offset);
}

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

/** The weekday key ("mon"...) of an instant, seen from a zone. */
export function weekdayInTz(utc: Date, timeZone: string): WeekdayKey {
  const p = wallClockParts(utc, timeZone);
  // Date.UTC of the wall-clock date gives its weekday directly.
  return WEEKDAY_KEYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
}

/** The wall-clock hour (0-23, fractional minutes) of an instant in a zone. */
export function hourInTz(utc: Date, timeZone: string): number {
  const p = wallClockParts(utc, timeZone);
  return p.hour + p.minute / 60;
}

/** The calendar date (YYYY-MM-DD) of an instant, seen from a zone. */
export function dateStringInTz(utc: Date, timeZone: string): string {
  const p = wallClockParts(utc, timeZone);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${mm}-${dd}`;
}

/** Adds whole days to a YYYY-MM-DD date string. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

/**
 * Human-friendly label for an instant in a zone, for chat and reminders:
 * "Tuesday, July 14 at 9:00 AM".
 */
export function formatInTz(utcIso: string, timeZone: string): string {
  const date = new Date(utcIso);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return `${day} at ${time}`;
}

/** Validates an IANA zone name. */
export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
