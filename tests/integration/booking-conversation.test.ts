import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatService } from "@/core/services/chat-service";
import { BookingOrchestrator } from "@halo/scheduling/booking-orchestrator";
import { SlotTakenError } from "@halo/scheduling/scheduling-repository";
import { createSchedulingFakes } from "../mocks/in-memory-scheduling";
import type { WidgetRepository } from "@/core/services/widget-repository";
import type { LLMProvider } from "@halo/ports/llm-provider";
import type { KnowledgeProvider } from "@halo/ports/knowledge-provider";
import type { NotificationProvider } from "@halo/ports/notification-provider";
import {
  DEFAULT_BRANDING,
  type Business,
  type ChatMessage,
  type Receptionist,
} from "@halo/core/domain/types";
import { InMemoryConversationStateStore } from "@halo/runtime/conversation-state";

/**
 * End-to-end booking conversations: real ChatService, real
 * BookingOrchestrator, real BookingService, in-memory database. Only the LLM
 * is faked — scripted per turn, exactly as the extraction pass would answer.
 *
 * These are the behaviours a visitor experiences, so they are asserted on
 * outcomes: which appointments exist, what the engine was told, and what the
 * reply model was allowed to claim.
 */

const NOW = new Date("2026-07-13T12:00:00Z"); // Monday 8:00 ET
const TUE_9AM = "2026-07-14T13:00:00.000Z";
const TUE_2PM = "2026-07-14T18:00:00.000Z";
const WED_9AM = "2026-07-15T13:00:00.000Z";

const business: Business = {
  id: "b1",
  name: "Cool Air HVAC",
  slug: "cool-air",
  description: "Heating and cooling",
  industry: "HVAC",
  website: "",
  phone: "+1 555 0199",
  email: "",
  address: "",
  businessHours: {
    mon: { open: "09:00", close: "17:00", closed: false },
    tue: { open: "09:00", close: "17:00", closed: false },
    wed: { open: "09:00", close: "17:00", closed: false },
    thu: { open: "09:00", close: "17:00", closed: false },
    fri: { open: "09:00", close: "17:00", closed: false },
  },
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
  leadCaptureEnabled: false,
  voiceEnabled: false,
  branding: DEFAULT_BRANDING,
};

/** What the extraction pass reports for one turn. */
interface Extraction {
  action?: "none" | "book" | "cancel";
  slotNumber?: number;
  name?: string;
  phone?: string;
  email?: string;
  service?: string;
  notes?: string;
}

function buildConversation() {
  const scheduling = createSchedulingFakes({ now: NOW });
  const messages: ChatMessage[] = [];
  /** The system prompt behind each visitor-facing reply, in order. */
  const replyPrompts: string[] = [];
  const extractions: Extraction[] = [];

  const llm: LLMProvider = {
    name: "fake",
    async complete(systemPrompt) {
      if (systemPrompt.startsWith("You watch a receptionist chat")) {
        const next = extractions.shift() ?? {};
        return {
          content: JSON.stringify({
            action: "none",
            slotNumber: 0,
            name: "",
            phone: "",
            email: "",
            service: "",
            notes: "",
            ...next,
          }),
          model: "fake",
        };
      }
      if (systemPrompt.startsWith("You extract contact details")) {
        return { content: JSON.stringify({ name: "", email: "", phone: "", intent: "" }), model: "fake" };
      }
      replyPrompts.push(systemPrompt);
      return { content: "(reply)", model: "fake" };
    },
    async isHealthy() {
      return true;
    },
  };

  const knowledge: KnowledgeProvider = {
    name: "fake",
    async search() {
      return [];
    },
    async indexDocument() {},
    async removeDocument() {},
  };

  const notifications: NotificationProvider = { name: "fake", async notifyNewLead() {} };

  const widgetRepository = {
    getRecentMessages: async () => messages.slice(),
    appendMessages: async (_c: string, _b: string, next: ChatMessage[]) => {
      messages.push(...next);
    },
    upsertConversationLead: async () => ({ isNew: false }),
    getBusinessNotificationSettings: async () => ({ notifyOnLead: false, notificationEmail: "" }),
    trackEvent: async () => {},
  } as unknown as WidgetRepository;

  const orchestrator = new BookingOrchestrator(scheduling.repository, scheduling.service, llm);
  const chat = new ChatService(
    llm,
    knowledge,
    notifications,
    widgetRepository,
    orchestrator,
    async () => {},
    { stateStore: new InMemoryConversationStateStore() },
  );

  /** One visitor turn, with the extraction the model would return for it. */
  async function say(userMessage: string, extraction: Extraction = {}) {
    extractions.push(extraction);
    await chat.respond({ business, receptionist, conversationId: "c1", userMessage });
    return replyPrompts[replyPrompts.length - 1];
  }

  return { ...scheduling, say, messages, replyPrompts };
}

beforeEach(() => {
  // ChatService takes no clock; freeze Date so slot maths is deterministic.
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("booking conversations, end to end", () => {
  it("books across several turns, confirming only after the engine succeeds", async () => {
    const { say, appointments, sent, drafts } = buildConversation();

    const turn1 = await say("Hi, I need to book an AC service", { service: "AC servicing" });
    expect(appointments).toHaveLength(0);
    expect(turn1).toContain("The appointment is NOT booked");
    expect(turn1).toContain("Service: AC servicing");

    const turn2 = await say("tomorrow morning would be great");
    expect(appointments).toHaveLength(0);
    expect(turn2).toContain("Tuesday, July 14 at 9:00 AM");
    expect(turn2).toContain("The appointment is NOT booked");

    const turn3 = await say("9am works for me", { action: "book", slotNumber: 1 });
    // Time agreed, but the visitor is still a stranger — no booking yet.
    expect(appointments).toHaveLength(0);
    expect(turn3).toContain("Still needed before this can be booked: name, contact");
    expect(drafts.get("c1")).toMatchObject({ time: "09:00", timeCommitted: true });

    const turn4 = await say("I'm Sam, +1 555 0100", { name: "Sam", phone: "+1 555 0100" });
    expect(appointments).toHaveLength(1);
    expect(appointments[0]).toMatchObject({
      startsAt: TUE_9AM,
      serviceName: "AC servicing",
      visitorName: "Sam",
      visitorPhone: "+1 555 0100",
      status: "confirmed",
    });
    expect(turn4).toContain("JUST successfully booked");
    // Draft consumed, confirmation actually sent.
    expect(drafts.has("c1")).toBe(false);
    expect(sent.some((m) => m.body.includes("Tuesday, July 14 at 9:00 AM"))).toBe(true);
  });

  it("books from a single message carrying every detail", async () => {
    const { say, appointments } = buildConversation();

    const prompt = await say(
      [
        "I'd like to book a boiler service tomorrow at 9am.",
        "Name:",
        "John",
        "Phone:",
        "+1 555 0142",
        "Email:",
        "john@example.com",
      ].join("\n"),
      { action: "book", slotNumber: 1, service: "boiler service" },
    );

    expect(appointments).toHaveLength(1);
    expect(appointments[0]).toMatchObject({
      serviceName: "boiler service",
      visitorName: "John",
      visitorPhone: "+1 555 0142",
      visitorEmail: "john@example.com",
      startsAt: TUE_9AM,
    });
    expect(prompt).toContain("JUST successfully booked");
  });

  it("never re-asks for something the visitor already said", async () => {
    const { say } = buildConversation();

    await say("can I book an AC service?", { service: "AC servicing" });
    await say("my name is Sam and my number is +1 555 0100", { name: "Sam", phone: "+1 555 0100" });
    const prompt = await say("what days do you have?");

    expect(prompt).toContain("never ask for any of them again");
    expect(prompt).toContain("Name: Sam");
    expect(prompt).toContain("Phone: +1 555 0100");
    // Only the time is outstanding — so that is the one thing to ask about.
    expect(prompt).toContain("Still needed before this can be booked: time");
  });

  it("applies a correction instead of booking the superseded detail", async () => {
    const { say, appointments } = buildConversation();

    await say("I need to book an AC service", { service: "AC servicing" });
    await say("I'm Sam, my number is +1 555 0100", { name: "Sam", phone: "+1 555 0100" });
    await say("sorry, that number's wrong — use +1 555 0199", { phone: "+1 555 0199" });
    // A question about a time is not agreement to it: still nothing booked.
    await say("could I come tomorrow at 9am?");
    expect(appointments).toHaveLength(0);

    const prompt = await say("actually, make it 2pm instead");

    expect(appointments).toHaveLength(1);
    expect(appointments[0].startsAt).toBe(TUE_2PM);
    expect(appointments[0].visitorPhone).toBe("+1 555 0199");
    expect(prompt).toContain("JUST successfully booked");
  });

  it("does not book twice when the visitor repeats themselves", async () => {
    const { say, appointments } = buildConversation();

    const confirm = "9am tomorrow works, I'm Sam on +1 555 0100";
    const extraction: Extraction = {
      action: "book",
      slotNumber: 1,
      name: "Sam",
      phone: "+1 555 0100",
      service: "AC servicing",
    };
    await say(confirm, extraction);
    expect(appointments).toHaveLength(1);

    // The visitor's connection dropped and they sent it again.
    const again = await say(confirm, extraction);
    expect(appointments).toHaveLength(1);
    expect(again).not.toContain("JUST successfully booked");
    expect(again).toContain("already has this exact appointment");
    expect(again).toContain("Do NOT book anything new");
  });

  it("reschedules an existing appointment rather than creating a second one", async () => {
    const { say, appointments, sent } = buildConversation();

    await say("book AC servicing tomorrow at 9am, I'm Sam on +1 555 0100", {
      action: "book",
      slotNumber: 1,
      name: "Sam",
      phone: "+1 555 0100",
      service: "AC servicing",
    });
    expect(appointments).toHaveLength(1);

    const prompt = await say("something came up — can we move it to Wednesday at 9am?", {
      action: "book",
      slotNumber: 1,
    });

    expect(appointments).toHaveLength(1);
    expect(appointments[0].startsAt).toBe(WED_9AM);
    expect(prompt).toContain("JUST successfully moved");
    expect(sent.some((m) => m.body.includes("Wednesday, July 15 at 9:00 AM"))).toBe(true);
  });

  it("cancels a real appointment and frees the slot", async () => {
    const { say, appointments } = buildConversation();

    await say("book AC servicing tomorrow at 9am, I'm Sam on +1 555 0100", {
      action: "book",
      slotNumber: 1,
      name: "Sam",
      phone: "+1 555 0100",
      service: "AC servicing",
    });

    const prompt = await say("I need to cancel my appointment");
    expect(appointments[0].status).toBe("cancelled");
    expect(prompt).toContain("JUST cancelled");
  });

  it("does not claim a cancellation when there is nothing to cancel", async () => {
    const { say, appointments } = buildConversation();

    const prompt = await say("please cancel my appointment");

    expect(appointments).toHaveLength(0);
    expect(prompt).toContain("NO appointment on file");
    expect(prompt).toContain("must not say anything has");
  });

  it("reports a failed booking honestly and keeps the visitor's details", async () => {
    const conversation = buildConversation();
    const { say, appointments, drafts, repository } = conversation;

    // The exclusion constraint fires: someone else took the slot in the
    // moment between the availability read and the insert.
    const insert = repository.insertAppointment.bind(repository);
    let failed = false;
    repository.insertAppointment = async (...args: Parameters<typeof insert>) => {
      if (!failed) {
        failed = true;
        throw new SlotTakenError();
      }
      return insert(...args);
    };

    const prompt = await say("book AC servicing tomorrow at 9am, I'm Sam on +1 555 0100", {
      action: "book",
      slotNumber: 1,
      name: "Sam",
      phone: "+1 555 0100",
      service: "AC servicing",
    });

    expect(appointments).toHaveLength(0);
    expect(prompt).toContain("The booking FAILED");
    expect(prompt).toContain("do NOT pretend it is booked");
    // Real alternatives came back from the engine, and nothing was re-asked.
    expect(prompt).toMatch(/1\. Tuesday, July 14 at \d+:00 [AP]M/);
    expect(drafts.get("c1")).toMatchObject({
      name: "Sam",
      phone: "+1 555 0100",
      timeCommitted: false,
    });

    // The visitor picks one of the offered times; this one goes through.
    await say("ok, 10am then", { action: "book", slotNumber: 1 });
    expect(appointments).toHaveLength(1);
    expect(appointments[0].visitorName).toBe("Sam");
  });

  it("stays honest when the requested day has nothing open", async () => {
    const { say, appointments, service } = buildConversation();

    // Fill Tuesday completely.
    const { slots } = await service.getAvailability({ business, now: NOW, limit: 50 });
    for (const slot of slots.filter((s) => s.startsAt.startsWith("2026-07-14"))) {
      await service.book({
        business,
        conversationId: "other",
        slot,
        serviceName: "x",
        visitorName: "Someone",
        visitorPhone: "+1 555 0000",
        visitorEmail: "",
        now: NOW,
      });
    }
    const booked = appointments.length;

    const prompt = await say("anything tomorrow at 9am?", { service: "AC servicing" });

    expect(appointments).toHaveLength(booked);
    expect(prompt).toContain("is NOT available");
    expect(prompt).not.toContain("Tuesday, July 14");
    expect(prompt).toContain("The appointment is NOT booked");
  });

  it("keeps the conversation going when the extraction pass fails", async () => {
    const { say, appointments, drafts } = buildConversation();

    // No scripted extraction and a draft built only from the visitor's text.
    const prompt = await say("I want to book an appointment — I'm Sam, sam@example.com");

    expect(appointments).toHaveLength(0);
    expect(drafts.get("c1")).toMatchObject({ name: "Sam", email: "sam@example.com" });
    expect(prompt).toContain("Still needed before this can be booked");
  });

  it("leaves non-scheduling turns untouched by the booking layer", async () => {
    const { say } = buildConversation();

    const prompt = await say("do you service heat pumps?");

    // The headings are only ever present when the orchestrator injects them
    // (the base prompt merely names them in its instructions).
    expect(prompt).not.toContain("## Live scheduling");
    expect(prompt).not.toContain("## Booking status");
  });
});
