import { describe, expect, it } from "vitest";
import { buildRetrievalQuery, isSubstantiveQuestion } from "@halo/knowledge/retrieval-query";
import type { ChatMessage } from "@halo/core/domain/types";

const history: ChatMessage[] = [
  { role: "user", content: "Do you do teeth whitening?" },
  { role: "assistant", content: "Yes, we offer in-office whitening." },
];

describe("buildRetrievalQuery", () => {
  it("passes standalone questions through untouched", () => {
    const q = buildRetrievalQuery(history, "What insurance plans do you accept for cleanings?");
    expect(q).toBe("What insurance plans do you accept for cleanings?");
  });

  it("expands short follow-ups with recent visitor context", () => {
    const q = buildRetrievalQuery(history, "How much is it?");
    expect(q).toContain("teeth whitening");
    expect(q).toContain("How much is it?");
  });

  it("expands anaphoric openers even when longer", () => {
    const q = buildRetrievalQuery(history, "And do they take longer than an hour usually?");
    expect(q).toContain("teeth whitening");
  });

  it("only folds in visitor messages, never assistant text", () => {
    const q = buildRetrievalQuery(history, "how long?");
    expect(q).not.toContain("in-office");
  });

  it("returns the message as-is when there is no history", () => {
    expect(buildRetrievalQuery([], "how much?")).toBe("how much?");
  });

  it("handles empty input", () => {
    expect(buildRetrievalQuery(history, "  ")).toBe("");
  });
});

describe("isSubstantiveQuestion", () => {
  it("accepts real questions with or without a question mark", () => {
    expect(isSubstantiveQuestion("Do you offer weekend appointments")).toBe(true);
    expect(isSubstantiveQuestion("What brands of water heater do you install?")).toBe(true);
    expect(isSubstantiveQuestion("I was wondering about parking?")).toBe(true);
  });

  it("rejects greetings, one-liners and statements", () => {
    expect(isSubstantiveQuestion("hi")).toBe(false);
    expect(isSubstantiveQuestion("hello there!")).toBe(false);
    expect(isSubstantiveQuestion("thanks so much")).toBe(false);
    expect(isSubstantiveQuestion("ok")).toBe(false);
    expect(isSubstantiveQuestion("My name is Jane Smith")).toBe(false);
  });
});
