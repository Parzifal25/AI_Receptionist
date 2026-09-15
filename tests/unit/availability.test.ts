import { describe, expect, it } from "vitest";
import { generateSlots, isSlotAvailable } from "@halo/scheduling/availability";
import type { SchedulingSettings, StaffMember } from "@halo/core/domain/scheduling";

/**
 * Fixed scenario: a New York business, 9-5 Mon-Fri, 60-minute slots.
 * "Now" is Monday 2026-07-13 08:00 ET (12:00Z); we search Tuesday July 14.
 */
const NOW = new Date("2026-07-13T12:00:00Z");
const TUESDAY_9AM_ET = "2026-07-14T13:00:00.000Z";

const settings: SchedulingSettings = {
  businessId: "b1",
  bookingEnabled: true,
  timezone: "America/New_York",
  slotDurationMinutes: 60,
  bufferMinutes: 0,
  minNoticeMinutes: 120,
  maxAdvanceDays: 14,
  holidays: [],
  remindersEnabled: true,
  reminderLeadMinutes: [60],
  locationAddress: "",
  prepInstructions: "",
  intakeForm: [],
  reviewUrl: "",
  autoNoShowEnabled: false,
  noShowGraceMinutes: 30,
};

const businessHours = {
  mon: { open: "09:00", close: "17:00", closed: false },
  tue: { open: "09:00", close: "17:00", closed: false },
  wed: { open: "09:00", close: "17:00", closed: false },
  thu: { open: "09:00", close: "17:00", closed: false },
  fri: { open: "09:00", close: "17:00", closed: false },
  sat: { open: "09:00", close: "17:00", closed: true },
};

function staff(overrides: Partial<StaffMember> = {}): StaffMember {
  return {
    id: "s1",
    businessId: "b1",
    name: "Alex",
    role: "",
    workingHours: null,
    isActive: true,
    calendarProvider: "internal",
    calendarRef: "",
    ...overrides,
  };
}

const tuesday = { fromISO: "2026-07-14T00:00:00Z", toISO: "2026-07-15T00:00:00Z" };

function slotsFor(overrides: Partial<Parameters<typeof generateSlots>[0]> = {}) {
  return generateSlots({
    settings,
    businessHours,
    staff: [staff()],
    busyByStaff: new Map(),
    ...tuesday,
    now: NOW,
    ...overrides,
  });
}

describe("generateSlots", () => {
  it("fills working hours with slot-duration steps in the business timezone", () => {
    const slots = slotsFor();
    expect(slots).toHaveLength(8); // 9,10,...,16 ET
    expect(slots[0].startsAt).toBe(TUESDAY_9AM_ET);
    expect(slots[7].startsAt).toBe("2026-07-14T20:00:00.000Z"); // 4pm ET
  });

  it("skips closed days and holidays", () => {
    const sunday = slotsFor({ fromISO: "2026-07-19T00:00:00Z", toISO: "2026-07-20T00:00:00Z" });
    expect(sunday).toHaveLength(0);

    const holiday = slotsFor({
      settings: { ...settings, holidays: ["2026-07-14"] },
    });
    expect(holiday).toHaveLength(0);
  });

  it("respects minimum notice", () => {
    // Searching today with now=8am ET and 120 min notice → nothing before 10am.
    const today = slotsFor({ fromISO: "2026-07-13T00:00:00Z", toISO: "2026-07-14T00:00:00Z" });
    expect(today[0].startsAt).toBe("2026-07-13T14:00:00.000Z"); // 10am ET
  });

  it("respects the max-advance horizon", () => {
    const farFuture = slotsFor({
      fromISO: "2026-08-20T00:00:00Z",
      toISO: "2026-08-21T00:00:00Z",
    });
    expect(farFuture).toHaveLength(0);
  });

  it("excludes busy intervals, expanded by the buffer", () => {
    // Busy 10-11 ET. With a 30-min buffer, 9am and 11am slots die too.
    const busy = new Map([["s1", [{ start: "2026-07-14T14:00:00Z", end: "2026-07-14T15:00:00Z" }]]]);

    const noBuffer = slotsFor({ busyByStaff: busy });
    expect(noBuffer.map((s) => s.startsAt)).not.toContain("2026-07-14T14:00:00.000Z");
    expect(noBuffer).toHaveLength(7);

    const buffered = slotsFor({
      busyByStaff: busy,
      settings: { ...settings, bufferMinutes: 30 },
    });
    expect(buffered.map((s) => s.startsAt)).not.toContain(TUESDAY_9AM_ET);
    expect(buffered.map((s) => s.startsAt)).not.toContain("2026-07-14T15:00:00.000Z");
    expect(buffered).toHaveLength(5);
  });

  it("merges identical times across staff, spreading assignment round-robin", () => {
    const team = [staff(), staff({ id: "s2", name: "Blake" })];
    const slots = slotsFor({ staff: team });
    expect(slots).toHaveLength(8); // merged, not 16
    expect(new Set(slots.map((s) => s.staffId)).size).toBe(2); // both get work
  });

  it("uses per-staff working hours over business hours", () => {
    const partTimer = staff({
      workingHours: { tue: { open: "13:00", close: "15:00", closed: false } },
    });
    const slots = slotsFor({ staff: [partTimer] });
    expect(slots.map((s) => s.startsAt)).toEqual([
      "2026-07-14T17:00:00.000Z", // 1pm ET
      "2026-07-14T18:00:00.000Z",
    ]);
  });

  it("filters by local time-of-day when requested", () => {
    const mornings = slotsFor({ localHourRange: { startHour: 6, endHour: 12 } });
    expect(mornings.map((s) => s.startsAt)).toEqual([
      TUESDAY_9AM_ET,
      "2026-07-14T14:00:00.000Z",
      "2026-07-14T15:00:00.000Z", // 9, 10, 11 ET
    ]);
  });

  it("returns nothing when no staff are active", () => {
    expect(slotsFor({ staff: [staff({ isActive: false })] })).toHaveLength(0);
  });
});

describe("isSlotAvailable", () => {
  const base = {
    settings,
    businessHours,
    staff: [staff()],
    busyByStaff: new Map(),
    now: NOW,
    staffId: "s1",
  };

  it("accepts an open, aligned slot", () => {
    expect(
      isSlotAvailable({
        ...base,
        startsAt: TUESDAY_9AM_ET,
        endsAt: "2026-07-14T14:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("rejects a slot that collides with busy time", () => {
    expect(
      isSlotAvailable({
        ...base,
        busyByStaff: new Map([
          ["s1", [{ start: "2026-07-14T13:30:00Z", end: "2026-07-14T14:30:00Z" }]],
        ]),
        startsAt: TUESDAY_9AM_ET,
        endsAt: "2026-07-14T14:00:00.000Z",
      }),
    ).toBe(false);
  });
});
