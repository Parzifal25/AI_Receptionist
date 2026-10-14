import { describe, expect, it } from "vitest";
import { parseQualificationSchema } from "@halo/qualification/schema";

const question = { "te-IN": "ప్రశ్న?" };
const option = { value: "yes", keywords: { "te-IN": ["అవును"] } };
const field = { id: "first", type: "enum", questions: question, options: [option] };
const parse = (fields: unknown[], extra = {}) => parseQualificationSchema({ version: "v1", language: "te-IN", fields, ...extra });

describe("qualification configuration integrity", () => {
  it("accepts an earlier dependency with a defined option", () => {
    expect(parse([field, { id: "second", type: "text", questions: question, skipWhen: { field: "first", equals: ["yes"] } }]).ok).toBe(true);
  });

  it.each([
    ["blank question", [{ ...field, questions: { "te-IN": "   " } }]],
    ["duplicate options", [{ ...field, options: [option, option] }]],
    ["missing primary-language keywords", [{ ...field, options: [{ ...option, keywords: { "en-IN": ["yes"] } }] }]],
    ["blank primary-language keywords", [{ ...field, options: [{ ...option, keywords: { "te-IN": [" "] } }] }]],
    ["unknown disqualification option", [{ ...field, disqualifyWhen: { equals: ["missing"], reason: "Not eligible" } }]],
    ["self dependency", [{ ...field, skipWhen: { field: "first", equals: ["yes"] } }]],
    ["forward dependency", [{ id: "second", type: "text", questions: question, skipWhen: { field: "first", equals: ["yes"] } }, field]],
    ["unknown skip option", [field, { id: "second", type: "text", questions: question, skipWhen: { field: "first", equals: ["missing"] } }]],
  ])("rejects %s", (_name, fields) => {
    expect(parse(fields).ok).toBe(false);
  });

  it.each([{ min: 10, max: 1 }, { min: -1, max: 100 }, { min: 10, max: 10 }])("rejects invalid bill bounds %j", (amountInr) => {
    expect(parse([field], { billRanges: { amountInr, unitsKwh: { min: 1, max: 100 } } }).ok).toBe(false);
  });
});
