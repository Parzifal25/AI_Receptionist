import { describe, expect, it } from "vitest";
import {
  addDays,
  dateStringInTz,
  formatInTz,
  hourInTz,
  isValidTimezone,
  timezoneOffsetMs,
  weekdayInTz,
  zonedTimeToUtc,
} from "@halo/scheduling/timezone";

describe("zonedTimeToUtc", () => {
  it("converts standard-time wall clocks to UTC", () => {
    // January: New York is UTC-5.
    const jan = zonedTimeToUtc("America/New_York", 2026, 1, 15, 9, 0);
    expect(jan.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("converts daylight-time wall clocks to UTC", () => {
    // July: New York is UTC-4.
    const jul = zonedTimeToUtc("America/New_York", 2026, 7, 15, 9, 0);
    expect(jul.toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });

  it("handles zones ahead of UTC", () => {
    const tokyo = zonedTimeToUtc("Asia/Tokyo", 2026, 7, 15, 9, 0);
    expect(tokyo.toISOString()).toBe("2026-07-15T00:00:00.000Z");
  });

  it("treats UTC as identity", () => {
    expect(zonedTimeToUtc("UTC", 2026, 7, 15, 9, 30).toISOString()).toBe(
      "2026-07-15T09:30:00.000Z",
    );
  });

  it("stays monotonic across a DST transition", () => {
    // US spring-forward 2026: March 8, 02:00 → 03:00 in New York.
    const before = zonedTimeToUtc("America/New_York", 2026, 3, 8, 1, 30);
    const after = zonedTimeToUtc("America/New_York", 2026, 3, 8, 3, 30);
    expect(before.getTime()).toBeLessThan(after.getTime());
  });
});

describe("timezone helpers", () => {
  it("reports the offset for an instant", () => {
    expect(timezoneOffsetMs(new Date("2026-01-15T12:00:00Z"), "America/New_York")).toBe(
      -5 * 3_600_000,
    );
    expect(timezoneOffsetMs(new Date("2026-07-15T12:00:00Z"), "America/New_York")).toBe(
      -4 * 3_600_000,
    );
  });

  it("derives weekday and date in a zone, across the date line", () => {
    // 2026-07-15T23:30Z is already July 16 in Tokyo (a Thursday).
    const instant = new Date("2026-07-15T23:30:00Z");
    expect(dateStringInTz(instant, "Asia/Tokyo")).toBe("2026-07-16");
    expect(weekdayInTz(instant, "Asia/Tokyo")).toBe("thu");
    expect(dateStringInTz(instant, "America/New_York")).toBe("2026-07-15");
    expect(weekdayInTz(instant, "America/New_York")).toBe("wed");
  });

  it("reports the local hour", () => {
    expect(hourInTz(new Date("2026-07-15T13:30:00Z"), "America/New_York")).toBe(9.5);
  });

  it("adds days across month boundaries", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("formats a friendly label in the business zone", () => {
    const label = formatInTz("2026-07-14T13:00:00.000Z", "America/New_York");
    expect(label).toBe("Tuesday, July 14 at 9:00 AM");
  });

  it("validates IANA zone names", () => {
    expect(isValidTimezone("America/Chicago")).toBe(true);
    expect(isValidTimezone("Mars/Olympus_Mons")).toBe(false);
  });
});
