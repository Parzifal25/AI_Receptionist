import { addDays, dateStringInTz, zonedTimeToUtc } from "./timezone";

/**
 * Deterministic parser for the date expressions visitors actually type —
 * "tomorrow", "next tuesday", "friday morning", "july 15". Turns them into a
 * UTC search window (plus an optional local time-of-day filter) for the
 * availability engine. No LLM: cheap, testable, and never hallucinates a
 * date. Returns null when nothing time-like is found, in which case the
 * caller searches the whole booking horizon.
 */

export interface WhenWindow {
  fromISO: string;
  toISO: string;
  /** What the parser understood, e.g. "tomorrow" — for logging/eval. */
  label: string;
  localHourRange?: { startHour: number; endHour: number };
  /**
   * The visitor named a specific clock time ("at 10 AM"), not just a day
   * part. When the hour turns out to be fully booked, the caller should
   * offer nearby alternatives rather than reporting the day as unavailable.
   */
  exactTime?: boolean;
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const TIME_OF_DAY: Record<string, { startHour: number; endHour: number }> = {
  morning: { startHour: 6, endHour: 12 },
  afternoon: { startHour: 12, endHour: 17 },
  evening: { startHour: 17, endHour: 21 },
};

/**
 * Extracts an explicit clock time — "at 10", "10:30 am", "2 pm", "14:00",
 * "5 o'clock", "noon". Returns the local hour (0–23) or null. Anchored to
 * "at/around/by", a meridiem, a colon, or "o'clock" so bare numbers in
 * dates ("july 15") never match.
 */
export function parseClockTime(
  lower: string,
  preferredRange?: { startHour: number; endHour: number },
): { hour: number; label: string } | null {
  if (/\bnoon\b|\bmid-?day\b/.test(lower)) return { hour: 12, label: "noon" };

  const match =
    lower.match(/\b(?:at|around|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/) ??
    lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/) ??
    lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*o'?clock\b/) ??
    lower.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!match) return null;

  const raw = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.startsWith("p") ? "pm" : match[3]?.startsWith("a") ? "am" : null;
  if (!Number.isFinite(raw) || raw > 23 || minutes > 59) return null;

  let hour: number;
  if (meridiem === "pm") hour = (raw % 12) + 12;
  else if (meridiem === "am") hour = raw % 12;
  else if (raw >= 13) hour = raw; // 24-hour form, e.g. "14:00"
  else {
    // No am/pm. Prefer the reading that lands inside an already-stated day
    // part ("tonight at 8" → 20:00); otherwise small hours mean afternoon
    // for a business ("at 2" → 14:00) and 8–12 stay morning/noon.
    const pm = (raw % 12) + 12;
    if (preferredRange && pm >= preferredRange.startHour && pm < preferredRange.endHour) {
      hour = pm;
    } else if (preferredRange && raw >= preferredRange.startHour && raw < preferredRange.endHour) {
      hour = raw;
    } else {
      hour = raw >= 1 && raw <= 7 ? pm : raw;
    }
  }
  if (hour > 23) return null;

  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  const displayMin = minutes ? `:${String(minutes).padStart(2, "0")}` : "";
  return { hour, label: `${displayHour}${displayMin} ${hour < 12 ? "am" : "pm"}` };
}

function dayWindow(timezone: string, date: string, days = 1): { fromISO: string; toISO: string } {
  const [y, m, d] = date.split("-").map(Number);
  const from = zonedTimeToUtc(timezone, y, m, d, 0);
  const [y2, m2, d2] = addDays(date, days).split("-").map(Number);
  const to = zonedTimeToUtc(timezone, y2, m2, d2, 0);
  return { fromISO: from.toISOString(), toISO: to.toISOString() };
}

/**
 * Parses the visitor's message for a date/time expression, interpreted in
 * the business timezone relative to `now`.
 */
export function parseWhen(text: string, now: Date, timezone: string): WhenWindow | null {
  const lower = text.toLowerCase();
  const today = dateStringInTz(now, timezone);

  const hourRange = Object.entries(TIME_OF_DAY).find(([word]) => lower.includes(word))?.[1];
  // "tonight at 8" carries an evening reading for the ambiguous "8".
  const clock = parseClockTime(
    lower,
    hourRange ?? (/\btonight\b/.test(lower) ? TIME_OF_DAY.evening : undefined),
  );

  // An explicit clock time narrows the search to that hour and beats a
  // vaguer day-part word ("tomorrow morning at 10" → 10:00, not 6–12).
  const withTod = (window: { fromISO: string; toISO: string }, label: string): WhenWindow => ({
    ...window,
    label: clock ? `${label} at ${clock.label}` : label,
    ...(clock
      ? { localHourRange: { startHour: clock.hour, endHour: clock.hour + 1 }, exactTime: true }
      : hourRange
        ? { localHourRange: hourRange }
        : {}),
  });

  if (/\btoday\b/.test(lower) || /\btonight\b/.test(lower)) {
    const window = withTod(dayWindow(timezone, today), "today");
    if (/\btonight\b/.test(lower) && !hourRange && !clock) {
      window.localHourRange = TIME_OF_DAY.evening;
    }
    return window;
  }
  if (/\btomorrow\b/.test(lower)) {
    return withTod(dayWindow(timezone, addDays(today, 1)), "tomorrow");
  }
  if (/\bnext week\b/.test(lower)) {
    // The upcoming Monday through Sunday.
    const todayDow = new Date(`${today}T12:00:00Z`).getUTCDay();
    const daysToMonday = ((8 - todayDow) % 7) || 7;
    return withTod(dayWindow(timezone, addDays(today, daysToMonday), 7), "next week");
  }
  if (/\bthis week\b/.test(lower)) {
    return withTod(dayWindow(timezone, addDays(today, 1), 6), "this week");
  }
  if (/\bweekend\b/.test(lower)) {
    const todayDow = new Date(`${today}T12:00:00Z`).getUTCDay();
    const daysToSaturday = (6 - todayDow + 7) % 7 || 7;
    return withTod(dayWindow(timezone, addDays(today, daysToSaturday), 2), "weekend");
  }

  // Named weekday: "friday", "next friday", "on tuesday".
  for (let i = 0; i < WEEKDAYS.length; i++) {
    const re = new RegExp(`\\b(next\\s+)?${WEEKDAYS[i]}\\b`);
    const match = lower.match(re);
    if (!match) continue;
    const todayDow = new Date(`${today}T12:00:00Z`).getUTCDay();
    let delta = (i - todayDow + 7) % 7;
    if (delta === 0) delta = 7; // bare weekday name means the upcoming one
    if (match[1] && delta < 7) delta += 7; // "next friday" = the following week's
    return withTod(dayWindow(timezone, addDays(today, delta)), WEEKDAYS[i]);
  }

  // "july 15", "15 july", "july 15th"
  for (let m = 0; m < MONTHS.length; m++) {
    const nameFirst = lower.match(new RegExp(`\\b${MONTHS[m]}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
    const dayFirst = lower.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTHS[m]}\\b`));
    const dayNum = nameFirst ? Number(nameFirst[1]) : dayFirst ? Number(dayFirst[1]) : null;
    if (dayNum === null || dayNum < 1 || dayNum > 31) continue;
    const [y] = today.split("-").map(Number);
    let date = `${y}-${String(m + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
    if (date < today) date = `${y + 1}${date.slice(4)}`; // past date → next year
    return withTod(dayWindow(timezone, date), `${MONTHS[m]} ${dayNum}`);
  }

  // A time without a date ("can you do 10 am?", "sometime in the morning")
  // — search the coming days with the hour filter applied.
  if (clock) {
    const window = dayWindow(timezone, addDays(today, 0), 8);
    return {
      ...window,
      label: `at ${clock.label}`,
      localHourRange: { startHour: clock.hour, endHour: clock.hour + 1 },
      exactTime: true,
    };
  }
  if (hourRange) {
    const window = dayWindow(timezone, addDays(today, 0), 8);
    return { ...window, label: "time of day", localHourRange: hourRange };
  }

  return null;
}
