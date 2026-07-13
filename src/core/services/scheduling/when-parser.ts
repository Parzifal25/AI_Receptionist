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

  const withTod = (window: { fromISO: string; toISO: string }, label: string): WhenWindow => ({
    ...window,
    label,
    ...(hourRange ? { localHourRange: hourRange } : {}),
  });

  if (/\btoday\b/.test(lower) || /\btonight\b/.test(lower)) {
    const window = withTod(dayWindow(timezone, today), "today");
    if (/\btonight\b/.test(lower) && !hourRange) window.localHourRange = TIME_OF_DAY.evening;
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

  // Time-of-day alone ("sometime in the morning") — search the horizon with
  // the hour filter; caller supplies the default range.
  if (hourRange) {
    const window = dayWindow(timezone, addDays(today, 0), 8);
    return { ...window, label: "time of day", localHourRange: hourRange };
  }

  return null;
}
