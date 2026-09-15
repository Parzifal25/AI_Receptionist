import { describe, expect, it } from "vitest";
import { scoreLead } from "@/core/services/lead-scorer";
import type { ChatMessage } from "@halo/core/domain/types";

describe("scoreLead", () => {
  it("scores an empty draft as cold with zero", () => {
    const q = scoreLead({}, []);
    expect(q.score).toBe(0);
    expect(q.temperature).toBe("cold");
  });

  it("rewards contactability", () => {
    const withPhone = scoreLead({ phone: "+1 555 0100" });
    const withEmail = scoreLead({ email: "a@b.com" });
    expect(withPhone.score).toBeGreaterThan(withEmail.score);
    expect(withPhone.signals).toContain("Shared phone number");
  });

  it("marks a complete, high-intent, urgent lead as hot", () => {
    const transcript: ChatMessage[] = [
      { role: "user", content: "What's your pricing? I need to book an appointment today" },
      { role: "assistant", content: "Happy to help!" },
      { role: "user", content: "Great, call me — it's urgent" },
    ];
    const q = scoreLead(
      { name: "Jane", email: "jane@x.com", phone: "+1 555 0100", intent: "book appointment" },
      transcript,
    );
    expect(q.temperature).toBe("hot");
    expect(q.score).toBeGreaterThanOrEqual(70);
    expect(q.signals).toContain("Showed buying intent");
    expect(q.signals).toContain("Expressed urgency");
  });

  it("treats a contactless, low-intent visitor as cold", () => {
    const q = scoreLead({ intent: "just browsing" }, [
      { role: "user", content: "just looking around" },
    ]);
    expect(q.temperature).toBe("cold");
  });

  it("caps the score at 100", () => {
    const transcript: ChatMessage[] = Array.from({ length: 6 }, () => ({
      role: "user" as const,
      content: "price cost quote book appointment schedule demo today urgent asap",
    }));
    const q = scoreLead(
      { name: "A", email: "a@b.com", phone: "123", intent: "buy now" },
      transcript,
    );
    expect(q.score).toBeLessThanOrEqual(100);
    expect(q.temperature).toBe("hot");
  });

  it("is deterministic for identical inputs", () => {
    const draft = { email: "a@b.com", intent: "pricing" };
    expect(scoreLead(draft)).toEqual(scoreLead(draft));
  });

  it("matches buying phrases on word boundaries only", () => {
    const q = scoreLead({}, [
      { role: "user", content: "I saw you on facebook and instagram" },
    ]);
    expect(q.signals).not.toContain("Showed buying intent");
  });

  // --- Visitor archetype simulations -------------------------------------

  it("classifies a burst-pipe visitor as an emergency to call immediately", () => {
    const q = scoreLead({ phone: "+1 555 0100", intent: "burst pipe flooding basement" }, [
      { role: "user", content: "Help — a burst pipe is flooding my basement right now!" },
    ]);
    expect(q.classification).toBe("emergency");
    expect(q.temperature).toBe("hot");
    expect(q.nextAction).toBe("Call immediately — emergency");
  });

  it("classifies SEO solicitation as spam and caps its score", () => {
    const q = scoreLead({ email: "spam@agency.example", name: "Growth Guru" }, [
      {
        role: "user",
        content: "We are a marketing agency offering SEO services to rank on Google. Book a call!",
      },
    ]);
    expect(q.classification).toBe("spam");
    expect(q.score).toBeLessThanOrEqual(10);
    expect(q.temperature).toBe("cold");
  });

  it("recognises a returning customer", () => {
    const q = scoreLead({ phone: "555" }, [
      { role: "user", content: "I'm an existing customer, you guys came out last spring" },
    ]);
    expect(q.classification).toBe("returning_customer");
    expect(q.signals).toContain("Existing customer");
    expect(q.nextAction).toBe("Call back soon — existing customer");
  });

  it("dampens the score when the visitor says they're just browsing", () => {
    const engaged = scoreLead({ email: "a@b.com" }, [
      { role: "user", content: "what are your prices?" },
    ]);
    const browsing = scoreLead({ email: "a@b.com" }, [
      { role: "user", content: "what are your prices? just browsing for now, not interested yet" },
    ]);
    expect(browsing.score).toBeLessThan(engaged.score);
    expect(browsing.signals).toContain("Said they're just looking");
  });

  it("rewards commitment language and near-term timelines", () => {
    const q = scoreLead({ phone: "555", name: "Sam" }, [
      { role: "user", content: "I'm ready to book — can you fit me in next week? It's for my house." },
    ]);
    expect(q.signals).toContain("Ready to commit");
    expect(q.signals).toContain("Likely decision maker");
    expect(q.temperature).toBe("hot");
  });

  it("always recommends a next action", () => {
    for (const draft of [{}, { phone: "555" }, { email: "a@b.com", intent: "book today" }]) {
      expect(scoreLead(draft).nextAction.length).toBeGreaterThan(0);
    }
  });
});
