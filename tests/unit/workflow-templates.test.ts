import { describe, expect, it } from "vitest";
import { workflowDefinitionSchema } from "@/core/domain/workflow";
import {
  getTemplate,
  instantiateTemplate,
  WORKFLOW_TEMPLATES,
} from "@/core/services/workflows/templates";

describe("workflow templates", () => {
  it("every template instantiates into schema-valid workflow definitions", () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const variables = Object.fromEntries(
        template.variables.map((v) => [v.key, v.example]),
      );
      const drafts = instantiateTemplate(template, variables);
      expect(drafts.length).toBe(template.workflows.length);
      for (const draft of drafts) {
        // Full-schema check with synthetic identity — what the store enforces.
        expect(() =>
          workflowDefinitionSchema.parse({ ...draft, id: "w1", businessId: "b1", version: 1 }),
        ).not.toThrow();
      }
    }
  });

  it("substitutes {{var.*}} but leaves {{event.*}} for run-time interpolation", () => {
    const template = getTemplate("post-visit-review")!;
    const drafts = instantiateTemplate(template, {
      reviewUrl: "https://g.page/cool-air/review",
    });
    const flattened = JSON.stringify(drafts);
    expect(flattened).toContain("https://g.page/cool-air/review");
    expect(flattened).not.toContain("{{var.");
    expect(flattened).toContain("{{event.payload.original.visitorEmail}}");
  });

  it("review journey follows the canonical lifecycle: completed → 1 day → review → 30 days → offer", () => {
    const template = getTemplate("post-visit-review")!;
    const [start, ask, offer] = template.workflows;
    expect(start.trigger).toBe("appointment.completed");
    expect(start.steps[0].params.delayMinutes).toBe(1440);
    expect(ask.trigger).toBe("followup.due");
    expect(ask.steps.map((s) => s.action)).toEqual(["request_review", "schedule_followup"]);
    expect(ask.steps[1].params.delayMinutes).toBe(43200);
    expect(offer.trigger).toBe("followup.due");
    expect(offer.steps[0].action).toBe("send_email");
  });

  it("rejects a missing required variable", () => {
    const template = getTemplate("post-visit-review")!;
    expect(() => instantiateTemplate(template, {})).toThrow(/reviewUrl/);
  });

  it("escapes variable values safely into JSON strings", () => {
    const template = getTemplate("post-visit-review")!;
    const drafts = instantiateTemplate(template, {
      reviewUrl: 'https://x.test/?a="b"\\c',
    });
    expect(JSON.stringify(drafts)).toContain("x.test");
  });
});
