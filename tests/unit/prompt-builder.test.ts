import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "@/core/services/prompt-builder";
import { DEFAULT_BRANDING, type Business, type Receptionist } from "@/core/domain/types";

const business: Business = {
  id: "b1",
  name: "Acme Dental",
  slug: "acme-dental",
  description: "A family dental clinic.",
  industry: "Dentistry",
  website: "https://acme.example",
  phone: "+1 555 0100",
  email: "hello@acme.example",
  address: "1 Main St",
  businessHours: {
    mon: { open: "09:00", close: "17:00", closed: false },
    sun: { open: "09:00", close: "17:00", closed: true },
  },
  logoUrl: "",
};

const receptionist: Receptionist = {
  id: "r1",
  businessId: "b1",
  name: "Riley",
  greeting: "Hi!",
  tone: "professional",
  language: "en",
  customInstructions: "Always mention the free checkup.",
  widgetKey: "k",
  isActive: true,
  leadCaptureEnabled: true,
  voiceEnabled: true,
  branding: DEFAULT_BRANDING,
};

describe("buildSystemPrompt", () => {
  it("includes identity, profile and hours", () => {
    const prompt = buildSystemPrompt({ business, receptionist, knowledge: [] });
    expect(prompt).toContain("You are Riley");
    expect(prompt).toContain("Acme Dental");
    expect(prompt).toContain("Monday: 09:00 - 17:00");
    expect(prompt).toContain("Sunday: Closed");
  });

  it("includes anti-hallucination rules", () => {
    const prompt = buildSystemPrompt({ business, receptionist, knowledge: [] });
    expect(prompt).toContain("Never invent");
    expect(prompt).toContain("say so honestly");
  });

  it("includes retrieved knowledge snippets", () => {
    const prompt = buildSystemPrompt({
      business,
      receptionist,
      knowledge: [
        { source: "faq", refId: "f1", content: "Q: Parking?\nA: Free lot behind the clinic.", score: 1 },
      ],
    });
    expect(prompt).toContain("Free lot behind the clinic");
  });

  it("omits the knowledge section when retrieval found nothing", () => {
    const prompt = buildSystemPrompt({ business, receptionist, knowledge: [] });
    expect(prompt).not.toContain("## Knowledge base");
  });

  it("includes lead capture only when enabled", () => {
    const withCapture = buildSystemPrompt({ business, receptionist, knowledge: [] });
    expect(withCapture).toContain("## Lead capture");

    const without = buildSystemPrompt({
      business,
      receptionist: { ...receptionist, leadCaptureEnabled: false },
      knowledge: [],
    });
    expect(without).not.toContain("## Lead capture");
  });

  it("includes custom instructions", () => {
    const prompt = buildSystemPrompt({ business, receptionist, knowledge: [] });
    expect(prompt).toContain("Always mention the free checkup.");
  });
});
