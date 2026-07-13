import { describe, expect, it } from "vitest";
import { parseWhen } from "@/core/services/scheduling/when-parser";

// Monday 2026-07-13, 08:00 in New York (12:00Z).
const NOW = new Date("2026-07-13T12:00:00Z");
const TZ = "America/New_York";

describe("parseWhen", () => {
  it("parses 'today' and 'tomorrow' as business-timezone days", () => {
    const today = parseWhen("can I come in today?", NOW, TZ);
    expect(today?.label).toBe("today");
    expect(today?.fromISO).toBe("2026-07-13T04:00:00.000Z"); // midnight ET

    const tomorrow = parseWhen("I'd like AC servicing tomorrow", NOW, TZ);
    expect(tomorrow?.label).toBe("tomorrow");
    expect(tomorrow?.fromISO).toBe("2026-07-14T04:00:00.000Z");
    expect(tomorrow?.toISO).toBe("2026-07-15T04:00:00.000Z");
  });

  it("parses named weekdays as the upcoming occurrence", () => {
    const friday = parseWhen("do you have anything friday?", NOW, TZ);
    expect(friday?.fromISO).toBe("2026-07-17T04:00:00.000Z");

    // "next monday" from a Monday = a week out, not today.
    const nextMonday = parseWhen("next monday works", NOW, TZ);
    expect(nextMonday?.fromISO).toBe("2026-07-20T04:00:00.000Z");
  });

  it("parses explicit dates, rolling past ones to next year", () => {
    const explicit = parseWhen("book me for july 20", NOW, TZ);
    expect(explicit?.fromISO).toBe("2026-07-20T04:00:00.000Z");

    const past = parseWhen("how about january 5?", NOW, TZ);
    expect(past?.fromISO.startsWith("2027-01-05")).toBe(true);
  });

  it("attaches time-of-day filters", () => {
    const morning = parseWhen("tomorrow morning if possible", NOW, TZ);
    expect(morning?.localHourRange).toEqual({ startHour: 6, endHour: 12 });

    const tonight = parseWhen("can someone come tonight?", NOW, TZ);
    expect(tonight?.label).toBe("today");
    expect(tonight?.localHourRange).toEqual({ startHour: 17, endHour: 21 });
  });

  it("parses week-scale windows", () => {
    const nextWeek = parseWhen("sometime next week", NOW, TZ);
    expect(nextWeek?.fromISO).toBe("2026-07-20T04:00:00.000Z"); // upcoming Monday
    expect(nextWeek?.toISO).toBe("2026-07-27T04:00:00.000Z");

    const weekend = parseWhen("this weekend?", NOW, TZ);
    expect(weekend?.fromISO).toBe("2026-07-18T04:00:00.000Z"); // Saturday
  });

  it("returns null when nothing time-like is present", () => {
    expect(parseWhen("how much is a cleaning?", NOW, TZ)).toBeNull();
    expect(parseWhen("I'd like to book an appointment", NOW, TZ)).toBeNull();
  });
});
