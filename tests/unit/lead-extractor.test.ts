import { describe, expect, it } from "vitest";
import {
  extractContactsDeterministic,
  extractLead,
  isLeadWorthSaving,
} from "@/core/services/lead-extractor";
import type { ChatMessage } from "@/core/domain/types";
import type { LLMProvider, LLMResult } from "@/core/ports/llm-provider";

function fakeLLM(response: string | Error): LLMProvider {
  return {
    name: "fake",
    async complete(): Promise<LLMResult> {
      if (response instanceof Error) throw response;
      return { content: response, model: "fake" };
    },
    async isHealthy() {
      return true;
    },
  };
}

const asUser = (content: string): ChatMessage => ({ role: "user", content });

describe("extractContactsDeterministic", () => {
  it("extracts email addresses", () => {
    const draft = extractContactsDeterministic([asUser("reach me at jane@example.com thanks")]);
    expect(draft.email).toBe("jane@example.com");
  });

  it("extracts phone numbers", () => {
    const draft = extractContactsDeterministic([asUser("call me on +1 (555) 010-4477")]);
    expect(draft.phone).toBe("+1 (555) 010-4477");
  });

  it("ignores assistant messages", () => {
    const draft = extractContactsDeterministic([
      { role: "assistant", content: "email us at office@business.com" },
    ]);
    expect(draft.email).toBeUndefined();
  });

  it("rejects digit strings that are not plausible phone numbers", () => {
    const draft = extractContactsDeterministic([asUser("my order id is 12345678901234567890")]);
    expect(draft.phone).toBeUndefined();
  });
});

describe("extractLead", () => {
  it("merges LLM name/intent with regex contacts, regex winning on conflicts", async () => {
    const llm = fakeLLM(
      JSON.stringify({ name: "Jane", email: "wrong@example.com", phone: "", intent: "book a cleaning" }),
    );
    const draft = await extractLead(llm, [asUser("I'm Jane, jane@real.com, I want a cleaning")]);
    expect(draft.name).toBe("Jane");
    expect(draft.email).toBe("jane@real.com"); // regex ground truth wins
    expect(draft.intent).toBe("book a cleaning");
  });

  it("degrades to regex-only when the LLM fails", async () => {
    const llm = fakeLLM(new Error("provider down"));
    const draft = await extractLead(llm, [asUser("email: bob@example.com")]);
    expect(draft.email).toBe("bob@example.com");
    expect(draft.name).toBeUndefined();
  });

  it("degrades gracefully on malformed LLM JSON", async () => {
    const llm = fakeLLM("not json at all");
    const draft = await extractLead(llm, [asUser("phone 5550104477")]);
    expect(draft.phone).toBe("5550104477");
  });
});

describe("isLeadWorthSaving", () => {
  it("requires a contact method", () => {
    expect(isLeadWorthSaving({ name: "Jane", intent: "pricing" })).toBe(false);
    expect(isLeadWorthSaving({ email: "a@b.co" })).toBe(true);
    expect(isLeadWorthSaving({ phone: "5550104477" })).toBe(true);
  });
});
