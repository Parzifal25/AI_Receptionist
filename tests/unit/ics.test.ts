import { describe, expect, it } from "vitest";
import { parseIcsBusy, toIcsStamp } from "@/providers/calendar/caldav-calendar-provider";

describe("toIcsStamp", () => {
  it("converts ISO instants to ICS UTC stamps", () => {
    expect(toIcsStamp("2026-07-14T09:00:00.000Z")).toBe("20260714T090000Z");
  });
});

describe("parseIcsBusy", () => {
  it("extracts DTSTART/DTEND from every VEVENT in a multistatus body", () => {
    const body = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:propstat><d:prop><c:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:abc
DTSTART:20260714T130000Z
DTEND:20260714T140000Z
SUMMARY:Existing booking
END:VEVENT
END:VCALENDAR</c:calendar-data></d:prop></d:propstat></d:response>
  <d:response><d:propstat><d:prop><c:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:def
DTSTART;VALUE=DATE:20260715
DTEND;VALUE=DATE:20260716
END:VEVENT
END:VCALENDAR</c:calendar-data></d:prop></d:propstat></d:response>
</d:multistatus>`;

    expect(parseIcsBusy(body)).toEqual([
      { start: "2026-07-14T13:00:00.000Z", end: "2026-07-14T14:00:00.000Z" },
      { start: "2026-07-15T00:00:00.000Z", end: "2026-07-16T00:00:00.000Z" },
    ]);
  });

  it("skips events with stamps it can't read instead of misreading them", () => {
    const body = `BEGIN:VEVENT
DTSTART;TZID=America/New_York:20260714T090000
DTEND;TZID=America/New_York:20260714T100000
END:VEVENT`;
    expect(parseIcsBusy(body)).toEqual([]);
  });

  it("handles empty bodies", () => {
    expect(parseIcsBusy("")).toEqual([]);
  });
});
