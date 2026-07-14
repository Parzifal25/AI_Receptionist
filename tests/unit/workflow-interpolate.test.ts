import { describe, expect, it } from "vitest";
import type { BusinessEvent } from "@/core/domain/workflow";
import {
  eventMatches,
  interpolateParams,
  interpolateString,
  resolvePath,
} from "@/core/services/workflows/interpolate";

const event: BusinessEvent = {
  id: "evt-1",
  businessId: "biz-1",
  type: "appointment.created",
  correlationId: "conv-9",
  occurredAt: "2026-07-14T10:00:00.000Z",
  payload: {
    visitorName: "Ada",
    visitorEmail: "ada@example.com",
    amount: 150,
    nested: { city: "London" },
    empty: "",
  },
};

describe("resolvePath", () => {
  it("walks dot paths and returns undefined for misses", () => {
    expect(resolvePath(event, "payload.nested.city")).toBe("London");
    expect(resolvePath(event, "payload.missing.deep")).toBeUndefined();
    expect(resolvePath(event, "type")).toBe("appointment.created");
  });
});

describe("interpolateString", () => {
  it("substitutes placeholders inside text", () => {
    expect(interpolateString("Hi {{event.payload.visitorName}}!", event)).toBe("Hi Ada!");
  });

  it("preserves raw types for exact single placeholders", () => {
    expect(interpolateString("{{event.payload.amount}}", event)).toBe(150);
    expect(interpolateString("{{event.payload.nested}}", event)).toEqual({ city: "London" });
  });

  it("renders missing values as empty strings", () => {
    expect(interpolateString("x={{event.payload.nope}}!", event)).toBe("x=!");
    expect(interpolateString("{{event.payload.nope}}", event)).toBe("");
  });
});

describe("interpolateParams", () => {
  it("walks nested params and arrays", () => {
    const params = interpolateParams(
      {
        to: "{{event.payload.visitorEmail}}",
        meta: { city: "{{event.payload.nested.city}}", fixed: 1 },
        tags: ["{{event.type}}", "static"],
      },
      event,
    );
    expect(params).toEqual({
      to: "ada@example.com",
      meta: { city: "London", fixed: 1 },
      tags: ["appointment.created", "static"],
    });
  });
});

describe("eventMatches", () => {
  it("empty conditions always match", () => {
    expect(eventMatches(event, [])).toBe(true);
  });

  it("applies AND semantics across conditions", () => {
    expect(
      eventMatches(event, [
        { path: "payload.visitorEmail", op: "exists" },
        { path: "payload.amount", op: "gt", value: 100 },
      ]),
    ).toBe(true);
    expect(
      eventMatches(event, [
        { path: "payload.visitorEmail", op: "exists" },
        { path: "payload.amount", op: "gt", value: 200 },
      ]),
    ).toBe(false);
  });

  it("supports eq/neq/contains/exists/not_exists/lt", () => {
    expect(eventMatches(event, [{ path: "payload.visitorName", op: "eq", value: "Ada" }])).toBe(true);
    expect(eventMatches(event, [{ path: "payload.visitorName", op: "neq", value: "Bob" }])).toBe(true);
    expect(eventMatches(event, [{ path: "payload.visitorEmail", op: "contains", value: "EXAMPLE.com" }])).toBe(true);
    expect(eventMatches(event, [{ path: "payload.empty", op: "not_exists" }])).toBe(true);
    expect(eventMatches(event, [{ path: "payload.missing", op: "not_exists" }])).toBe(true);
    expect(eventMatches(event, [{ path: "payload.amount", op: "lt", value: 200 }])).toBe(true);
    expect(eventMatches(event, [{ path: "payload.amount", op: "lt", value: 100 }])).toBe(false);
  });
});
