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

/** The pre-W2.1 English-only gate, kept verbatim as the oracle for "English unchanged". */
function legacyEnglishGate(userMessage: string): boolean {
  const message = userMessage.trim();
  if (message.trim().split(/\s+/).filter(Boolean).length < 3) return false;
  if (/^(hi|hey|hello|good (morning|afternoon|evening)|thanks|thank you|ok(ay)?|bye|goodbye)\b/i.test(message)) return false;
  return message.includes("?") || /^(do|does|did|can|could|will|would|is|are|was|were|how|what|when|where|which|who|why|should)\b/i.test(message);
}

describe("isSubstantiveQuestion — language-configurable (G5.4)", () => {
  it("records Telugu-script questions, with and without a question mark", () => {
    expect(isSubstantiveQuestion("సోలార్ సబ్సిడీ ఎంత వస్తుంది?")).toBe(true);
    expect(isSubstantiveQuestion("ఇన్‌స్టాలేషన్ ఎప్పుడు చేస్తారు")).toBe(true);
    expect(isSubstantiveQuestion("ధర ఎంత")).toBe(true);
    expect(isSubstantiveQuestion("EMI ఉందా")).toBe(true);
  });

  it("records romanized Telugu and Tenglish questions", () => {
    expect(isSubstantiveQuestion("solar subsidy entha vastundi")).toBe(true);
    expect(isSubstantiveQuestion("installation ki ela apply cheyali")).toBe(true);
    expect(isSubstantiveQuestion("EMI facility undaa")).toBe(true);
    expect(isSubstantiveQuestion("mee office ekkada undi")).toBe(true);
  });

  it("does not count Telugu greetings, acknowledgements or statements", () => {
    expect(isSubstantiveQuestion("నమస్కారం అండి")).toBe(false);
    expect(isSubstantiveQuestion("namaskaram andi")).toBe(false);
    expect(isSubstantiveQuestion("sare andi")).toBe(false);
    expect(isSubstantiveQuestion("ధన్యవాదాలు")).toBe(false);
    expect(isSubstantiveQuestion("naaku solar kavali")).toBe(false);
    expect(isSubstantiveQuestion("నా బిల్లు మూడు వేలు")).toBe(false);
  });

  it("reads EMI as the loan, not as a question word", () => {
    expect(isSubstantiveQuestion("naaku EMI kavali")).toBe(false);
  });

  it("leaves English behaviour exactly as the old regex gate", () => {
    const openers = ["", "hi ", "Hello, ", "ok ", "okayish ", "Thanks ", "good morning ", "good  morning ", "Do ", "what ", "Whatever ", "Is ", "I ", "We "];
    const bodies = ["you offer weekend appointments", "about parking?", "is my name Jane", "the price", "parking", "do you install heaters?", "Ela is my name", "elaborate on the warranty", "meeting next week?", "the sale ends"];
    const corpus = [
      "Do you offer weekend appointments", "What brands of water heater do you install?", "I was wondering about parking?",
      "hi", "hello there!", "thanks so much", "ok", "My name is Jane Smith", "Hiya, are you open?", "  why   not here  ",
      ...openers.flatMap((o) => bodies.map((b) => `${o}${b}`)),
    ];
    for (const text of corpus) expect([text, isSubstantiveQuestion(text)]).toEqual([text, legacyEnglishGate(text)]);
  });
});
