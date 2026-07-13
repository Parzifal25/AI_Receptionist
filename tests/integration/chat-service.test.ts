import { describe, expect, it, vi } from "vitest";
import { ChatService } from "@/core/services/chat-service";
import type { BookingOrchestrator } from "@/core/services/scheduling/booking-orchestrator";
import type { WidgetRepository } from "@/core/services/widget-repository";
import type { LLMProvider } from "@/core/ports/llm-provider";
import type { KnowledgeProvider } from "@/core/ports/knowledge-provider";
import type { NotificationProvider } from "@/core/ports/notification-provider";
import { DEFAULT_BRANDING, type Business, type ChatMessage, type Receptionist } from "@/core/domain/types";

/**
 * Integration test of the full conversational turn with in-memory fakes for
 * every port — verifies orchestration (retrieval → prompt → persistence →
 * lead capture) without any network or database.
 */

const business: Business = {
  id: "b1",
  name: "Acme Dental",
  slug: "acme",
  description: "Clinic",
  industry: "",
  website: "",
  phone: "",
  email: "",
  address: "",
  businessHours: {},
  logoUrl: "",
};

const receptionist: Receptionist = {
  id: "r1",
  businessId: "b1",
  name: "Riley",
  greeting: "Hi",
  tone: "friendly",
  language: "en",
  customInstructions: "",
  widgetKey: "k",
  isActive: true,
  leadCaptureEnabled: true,
  voiceEnabled: true,
  branding: DEFAULT_BRANDING,
};

function buildFakes(options: { llmReplies: string[]; knowledgeEmpty?: boolean }) {
  const messages: ChatMessage[] = [];
  const leads: Array<{ businessId: string; draft: unknown }> = [];
  const events: string[] = [];
  let llmCall = 0;

  const llm: LLMProvider = {
    name: "fake",
    async complete(systemPrompt) {
      const reply = options.llmReplies[Math.min(llmCall, options.llmReplies.length - 1)];
      llmCall += 1;
      return { content: reply, model: "fake", usage: undefined, systemPrompt } as never;
    },
    async isHealthy() {
      return true;
    },
  };

  const knowledge: KnowledgeProvider = {
    name: "fake",
    async search() {
      if (options.knowledgeEmpty) return [];
      return [{ source: "faq" as const, refId: "f1", title: "Hours", content: "Q: Hours?\nA: 9-5", score: 1 }];
    },
    async indexDocument() {},
    async removeDocument() {},
  };

  const notifications: NotificationProvider & { sent: number } = {
    name: "fake",
    sent: 0,
    async notifyNewLead() {
      notifications.sent += 1;
    },
  };

  const repository = {
    getRecentMessages: vi.fn(async () => messages.slice()),
    appendMessages: vi.fn(async (_c: string, _b: string, next: ChatMessage[]) => {
      messages.push(...next);
    }),
    upsertConversationLead: vi.fn(async (businessId: string, _cid: string, draft: unknown) => {
      leads.push({ businessId, draft });
      return { isNew: true };
    }),
    getBusinessNotificationSettings: vi.fn(async () => ({
      notifyOnLead: true,
      notificationEmail: "owner@acme.example",
    })),
    trackEvent: vi.fn(async (_b: string, event: string) => {
      events.push(event);
    }),
  } as unknown as WidgetRepository;

  const service = new ChatService(llm, knowledge, notifications, repository);
  return { service, messages, leads, events, notifications, repository };
}

describe("ChatService.respond", () => {
  it("answers and persists both sides of the turn", async () => {
    const { service, messages } = buildFakes({ llmReplies: ["We are open 9 to 5."] });

    const { reply } = await service.respond({
      business,
      receptionist,
      conversationId: "c1",
      userMessage: "When are you open?",
    });

    expect(reply).toBe("We are open 9 to 5.");
    expect(messages).toEqual([
      { role: "user", content: "When are you open?" },
      { role: "assistant", content: "We are open 9 to 5." },
    ]);
  });

  it("captures a lead when the visitor shares contact details", async () => {
    const { service, leads, notifications } = buildFakes({
      llmReplies: [
        "Thanks! We'll be in touch.",
        JSON.stringify({ name: "Jane", email: "", phone: "", intent: "book appointment" }),
      ],
    });

    await service.respond({
      business,
      receptionist,
      conversationId: "c1",
      userMessage: "I'm Jane — email me at jane@example.com about an appointment",
    });

    expect(leads).toHaveLength(1);
    expect(leads[0].draft).toMatchObject({ email: "jane@example.com", name: "Jane" });
    expect(notifications.sent).toBe(1);
  });

  it("skips lead capture when disabled", async () => {
    const { service, leads } = buildFakes({ llmReplies: ["Sure."] });

    await service.respond({
      business,
      receptionist: { ...receptionist, leadCaptureEnabled: false },
      conversationId: "c1",
      userMessage: "email me at jane@example.com",
    });

    expect(leads).toHaveLength(0);
  });

  it("injects the booking context into the prompt and forces lead capture on a booking", async () => {
    const { messages, leads } = buildFakes({ llmReplies: [""] });
    const llmPrompts: string[] = [];
    const llm = {
      name: "fake",
      async complete(systemPrompt: string) {
        llmPrompts.push(systemPrompt);
        // First call answers the visitor; the extraction pass returns JSON.
        return llmPrompts.length === 1
          ? { content: "You're all set for 9am tomorrow, Sam!", model: "fake" }
          : {
              content: JSON.stringify({ name: "Sam", email: "", phone: "+1 555 0100", intent: "AC servicing" }),
              model: "fake",
            };
      },
      async isHealthy() {
        return true;
      },
    };

    const orchestrator = {
      prepareTurn: vi.fn(async () => ({
        promptSection: "## Booking status\nYou have JUST successfully booked the appointment.",
        bookedNow: true,
      })),
    } as unknown as BookingOrchestrator;

    const repository = {
      getRecentMessages: vi.fn(async () => messages),
      appendMessages: vi.fn(async () => {}),
      upsertConversationLead: vi.fn(async () => {
        leads.push({ businessId: "b1", draft: {} });
        return { isNew: false };
      }),
      getBusinessNotificationSettings: vi.fn(async () => ({ notifyOnLead: false, notificationEmail: "" })),
      trackEvent: vi.fn(async () => {}),
    } as unknown as WidgetRepository;

    const service = new ChatService(
      llm,
      { name: "fake", search: async () => [], indexDocument: async () => {}, removeDocument: async () => {} },
      { name: "fake", notifyNewLead: async () => {} },
      repository,
      orchestrator,
    );

    const { reply } = await service.respond({
      business,
      receptionist,
      conversationId: "c1",
      userMessage: "9am works, I'm Sam +1 555 0100",
    });

    expect(reply).toContain("all set");
    expect(llmPrompts[0]).toContain("JUST successfully booked");
    // bookedNow forced the lead-extraction pass on this very turn.
    expect(leads).toHaveLength(1);
  });

  it("records a knowledge gap when a real question retrieves nothing", async () => {
    const { service, events } = buildFakes({ llmReplies: ["Let me check on that."], knowledgeEmpty: true });

    await service.respond({
      business,
      receptionist: { ...receptionist, leadCaptureEnabled: false },
      conversationId: "c1",
      userMessage: "Do you install tankless water heaters?",
    });

    expect(events).toContain("unanswered_question");
  });

  it("does not record a knowledge gap for greetings", async () => {
    const { service, events } = buildFakes({ llmReplies: ["Hi!"], knowledgeEmpty: true });

    await service.respond({
      business,
      receptionist: { ...receptionist, leadCaptureEnabled: false },
      conversationId: "c1",
      userMessage: "hi",
    });

    expect(events).not.toContain("unanswered_question");
  });

  it("does not save a lead without contact info", async () => {
    const { service, leads } = buildFakes({
      llmReplies: [
        "Happy to help!",
        JSON.stringify({ name: "", email: "", phone: "", intent: "general question" }),
      ],
    });

    // Third visitor message triggers the periodic extraction pass.
    for (const text of ["hi", "what services do you offer", "tell me more"]) {
      await service.respond({ business, receptionist, conversationId: "c1", userMessage: text });
    }

    expect(leads).toHaveLength(0);
  });
});
