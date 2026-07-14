import { describe, expect, it } from "vitest";
import {
  buildIcsEvent,
  escapeIcsText,
  foldIcsLine,
  toIcsUtcStamp,
} from "@/lib/ics";

describe("toIcsUtcStamp", () => {
  it("converts ISO instants to ICS UTC stamps", () => {
    expect(toIcsUtcStamp("2026-07-14T13:00:00.000Z")).toBe("20260714T130000Z");
  });

  it("rejects garbage", () => {
    expect(() => toIcsUtcStamp("not-a-date")).toThrow(/invalid/i);
  });
});

describe("escapeIcsText", () => {
  it("escapes RFC 5545 special characters", () => {
    expect(escapeIcsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
  });
});

describe("foldIcsLine", () => {
  it("leaves short lines alone", () => {
    expect(foldIcsLine("SUMMARY:Short")).toBe("SUMMARY:Short");
  });

  it("folds long lines at 75 octets with a leading space", () => {
    const folded = foldIcsLine(`DESCRIPTION:${"x".repeat(200)}`);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(Buffer.from(lines[0], "utf8").length).toBeLessThanOrEqual(75);
    for (const continuation of lines.slice(1)) {
      expect(continuation.startsWith(" ")).toBe(true);
      expect(Buffer.from(continuation, "utf8").length).toBeLessThanOrEqual(75);
    }
    // Unfolding reproduces the original content.
    expect(folded.replace(/\r\n /g, "")).toBe(`DESCRIPTION:${"x".repeat(200)}`);
  });
});

describe("buildIcsEvent", () => {
  const input = {
    uid: "appt-a1@ai-receptionist",
    title: "AC servicing — Cool Air HVAC",
    description: "Bring your filter",
    location: "12 Main St, Springfield",
    startsAt: "2026-07-14T13:00:00.000Z",
    endsAt: "2026-07-14T14:00:00.000Z",
    url: "https://app.test/appt/tok",
    organizerName: "Cool Air HVAC",
    attendeeName: "Sam",
    attendeeEmail: "sam@example.com",
  };

  it("emits a valid single-event VCALENDAR", () => {
    const ics = buildIcsEvent(input);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("METHOD:REQUEST");
    expect(ics).toContain("UID:appt-a1@ai-receptionist");
    expect(ics).toContain("DTSTART:20260714T130000Z");
    expect(ics).toContain("DTEND:20260714T140000Z");
    expect(ics).toContain("STATUS:CONFIRMED");
    expect(ics).toContain("SUMMARY:AC servicing — Cool Air HVAC");
    expect(ics).toContain("LOCATION:12 Main St\\, Springfield");
    expect(ics).toContain("ATTENDEE;CN=Sam;ROLE=REQ-PARTICIPANT:MAILTO:sam@example.com");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("marks cancellations so calendars clean up", () => {
    const ics = buildIcsEvent({ ...input, method: "CANCEL", sequence: 2 });
    expect(ics).toContain("METHOD:CANCEL");
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics).toContain("SEQUENCE:2");
  });
});
