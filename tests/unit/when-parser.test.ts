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

  it("parses exact clock times with am/pm", () => {
    const tenAm = parseWhen("I want an appointment tomorrow at 10 AM", NOW, TZ);
    expect(tenAm?.label).toBe("tomorrow at 10 am");
    expect(tenAm?.fromISO).toBe("2026-07-14T04:00:00.000Z");
    expect(tenAm?.localHourRange).toEqual({ startHour: 10, endHour: 11 });
    expect(tenAm?.exactTime).toBe(true);

    const halfPast = parseWhen("friday 2:30pm works", NOW, TZ);
    expect(halfPast?.localHourRange).toEqual({ startHour: 14, endHour: 15 });
    expect(halfPast?.label).toBe("friday at 2:30 pm");
  });

  it("resolves ambiguous hours sensibly without am/pm", () => {
    // Small hours read as afternoon for a business.
    const atTwo = parseWhen("can I come in tomorrow at 2?", NOW, TZ);
    expect(atTwo?.localHourRange).toEqual({ startHour: 14, endHour: 15 });

    // 8–12 stay morning; 24-hour forms pass through; noon is 12.
    expect(parseWhen("tomorrow at 10", NOW, TZ)?.localHourRange?.startHour).toBe(10);
    expect(parseWhen("tomorrow at 14:00", NOW, TZ)?.localHourRange?.startHour).toBe(14);
    expect(parseWhen("tomorrow around noon", NOW, TZ)?.localHourRange?.startHour).toBe(12);

    // A stated day part disambiguates: "tonight at 8" is 20:00.
    const tonight = parseWhen("can someone come tonight at 8?", NOW, TZ);
    expect(tonight?.localHourRange).toEqual({ startHour: 20, endHour: 21 });

    // An exact time beats the broader day-part filter.
    const morningAtTen = parseWhen("tomorrow morning at 10", NOW, TZ);
    expect(morningAtTen?.localHourRange).toEqual({ startHour: 10, endHour: 11 });
  });

  it("searches the coming days when only a time is given", () => {
    const bare = parseWhen("do you have anything at 3 pm?", NOW, TZ);
    expect(bare?.label).toBe("at 3 pm");
    expect(bare?.exactTime).toBe(true);
    expect(bare?.localHourRange).toEqual({ startHour: 15, endHour: 16 });
  });

  it("never mistakes date digits for clock times", () => {
    const date = parseWhen("book me for july 20", NOW, TZ);
    expect(date?.exactTime).toBeUndefined();
    expect(date?.localHourRange).toBeUndefined();
  });

  it("returns null when nothing time-like is present", () => {
    expect(parseWhen("how much is a cleaning?", NOW, TZ)).toBeNull();
    expect(parseWhen("I'd like to book an appointment", NOW, TZ)).toBeNull();
  });
});
