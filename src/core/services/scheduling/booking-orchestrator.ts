import "server-only";
import { z } from "zod";
import type { Business, ChatMessage } from "@/core/domain/types";
import type { Appointment, TimeSlot } from "@/core/domain/scheduling";
import type { LLMProvider } from "@/core/ports/llm-provider";
import { BookingService } from "./booking-service";
import { SchedulingRepository } from "./scheduling-repository";
import { formatInTz } from "./timezone";
import { parseWhen } from "./when-parser";
import { getLLMProvider } from "@/providers/llm/factory";
import { logger } from "@/lib/logger";

const log = logger.child({ service: "booking-orchestrator" });

/** Messages that put the conversation into scheduling context. */
const SCHEDULING_INTENT_RE =
  /\b(book|booking|appointment|schedule|reschedule|re-book|rebook|cancel|availab|opening|slot|come in|fit me in|see (?:me|us)|visit)\b/i;

const CANCEL_RE = /\b(cancel|call (it )?off|can't make|cannot make|won't make)\b/i;

/** How many recent visitor turns keep scheduling context alive. */
const CONTEXT_TURNS = 3;
/** Slots surfaced to the model per turn. */
const SLOT_LIMIT = 6;

const actionSchema = z.object({
  action: z.enum(["none", "book", "cancel"]).catch("none"),
  slotNumber: z.number().int().catch(0),
  name: z.string().catch(""),
  phone: z.string().catch(""),
  email: z.string().catch(""),
  service: z.string().catch(""),
});

export interface BookingTurnContext {
  /** Extra system-prompt section for this turn (availability, booking result). */
  promptSection: string;
  /** True when an appointment was just booked/moved — forces lead capture. */
  bookedNow: boolean;
}

/**
 * Bridges conversation and the booking engine, one turn at a time and
 * stateless: each turn re-derives context from the transcript, live
 * availability, and any appointment already attached to the conversation.
 *
 * Order of operations inside a turn: detect scheduling context → fetch real
 * slots → extract the visitor's booking action (JSON mode) → execute it
 * against the booking engine → hand the *result* to the reply model. The
 * model never invents times and never claims a booking the engine didn't
 * make — it only narrates ground truth handed to it in the prompt.
 */
export class BookingOrchestrator {
  constructor(
    private readonly repository: SchedulingRepository = new SchedulingRepository(),
    private readonly booking: BookingService = new BookingService(repository),
    private readonly llm: LLMProvider = getLLMProvider(),
  ) {}

  async prepareTurn(params: {
    business: Business;
    conversationId: string;
    history: ChatMessage[];
    userMessage: string;
    now?: Date;
  }): Promise<BookingTurnContext | null> {
    const { business, conversationId, history, userMessage, now = new Date() } = params;

    const settings = await this.repository.getSettings(business.id);
    if (!settings.bookingEnabled) return null;

    const recentVisitorText = [
      ...history.filter((m) => m.role === "user").slice(-CONTEXT_TURNS).map((m) => m.content),
      userMessage,
    ].join("\n");

    // Real availability for the window the visitor asked about. A time
    // expression alone ("AC servicing tomorrow") is scheduling intent even
    // without a booking keyword.
    const window =
      parseWhen(userMessage, now, settings.timezone) ??
      parseWhen(recentVisitorText, now, settings.timezone);
    const inSchedulingContext = SCHEDULING_INTENT_RE.test(recentVisitorText) || window !== null;

    const existing = await this.repository.findLiveAppointmentByConversation(conversationId);
    if (!inSchedulingContext && !existing) return null;
    let { slots } = await this.booking.getAvailability({
      business,
      window,
      limit: SLOT_LIMIT,
      now,
    });

    // The visitor asked for a specific clock time that's fully booked:
    // re-search from the same moment without the hour filter so the model
    // can offer the next few genuinely open times instead of a dead end.
    let requestedTimeUnavailable = false;
    if (slots.length === 0 && window?.exactTime) {
      requestedTimeUnavailable = true;
      ({ slots } = await this.booking.getAvailability({
        business,
        window: { fromISO: window.fromISO, toISO: horizonEnd(window.fromISO), label: "alternatives" },
        limit: 3,
        now,
      }));
    }

    // What does the visitor want us to DO right now?
    const action = await this.extractAction({ history, userMessage, slots, existing });

    if (action.action === "cancel" && existing) {
      await this.booking.cancel({ business, appointment: existing, reason: "Visitor asked in chat" });
      return {
        promptSection:
          `## Booking status\n` +
          `You have JUST cancelled the visitor's appointment (${describe(existing)}). ` +
          `Confirm the cancellation warmly, and offer to find them a new time if they'd like.`,
        bookedNow: false,
      };
    }

    if (action.action === "book" && action.slotNumber >= 1 && action.slotNumber <= slots.length) {
      const slot = slots[action.slotNumber - 1];
      return this.executeBooking({ business, conversationId, slot, action, existing, settings_tz: settings.timezone, slots, now });
    }

    // No executable action yet — hand the model real slots to offer.
    return {
      promptSection: this.availabilitySection({
        slots,
        existing,
        timezone: settings.timezone,
        window: window?.label,
        requestedTimeUnavailable,
      }),
      bookedNow: false,
    };
  }

  private async executeBooking(params: {
    business: Business;
    conversationId: string;
    slot: TimeSlot;
    action: z.infer<typeof actionSchema>;
    existing: Appointment | null;
    settings_tz: string;
    slots: TimeSlot[];
    now: Date;
  }): Promise<BookingTurnContext> {
    const { business, conversationId, slot, action, existing, now } = params;

    const result = existing
      ? await this.booking.reschedule({ business, appointment: existing, slot, now })
      : await this.booking.book({
          business,
          conversationId,
          slot,
          serviceName: action.service,
          visitorName: action.name,
          visitorPhone: action.phone,
          visitorEmail: action.email,
          now,
        });

    if (result.ok) {
      const verb = existing ? "moved" : "booked";
      return {
        promptSection:
          `## Booking status\n` +
          `You have JUST successfully ${verb} the appointment: ${describe(result.appointment)}` +
          `${result.appointment.visitorName ? ` for ${result.appointment.visitorName}` : ""}. ` +
          `A confirmation is being sent to them. Confirm it warmly in one or two sentences, ` +
          `repeat the day and time, and ask if there's anything else you can help with. ` +
          `Do NOT ask for any more details — the booking is done.`,
        bookedNow: true,
      };
    }

    if (result.reason === "slot_taken") {
      const alternatives = result.alternatives
        .map((s, i) => `${i + 1}. ${formatInTz(s.startsAt, params.settings_tz)}`)
        .join("\n");
      return {
        promptSection:
          `## Booking status\n` +
          `The time the visitor chose was JUST taken by someone else — apologise briefly and it's important you do not pretend it's booked. ` +
          (alternatives
            ? `Offer these real alternatives instead:\n${alternatives}`
            : `There are no nearby alternatives — offer to have the team call them to find a time.`),
        bookedNow: false,
      };
    }

    return {
      promptSection:
        `## Booking status\n` +
        `The booking could not be completed yet: ${result.message}. ` +
        `Collect what's missing conversationally (one question), then confirm the time again.`,
      bookedNow: false,
    };
  }

  private availabilitySection(params: {
    slots: TimeSlot[];
    existing: Appointment | null;
    timezone: string;
    window?: string;
    /** The visitor's exact requested time is booked; slots are alternatives. */
    requestedTimeUnavailable?: boolean;
  }): string {
    const { slots, existing, timezone } = params;
    const lines: string[] = ["## Live scheduling (system-verified, this moment)"];

    if (existing) {
      lines.push(
        `The visitor already has an appointment: ${describe(existing)}. ` +
          `If they want to change or cancel it, help with that.`,
      );
    }

    if (params.requestedTimeUnavailable) {
      lines.push(
        `The exact time the visitor asked for (${params.window ?? "their requested time"}) is NOT available — ` +
          `say so honestly and never pretend otherwise.`,
      );
    }

    if (slots.length === 0) {
      lines.push(
        `There are NO open slots${params.window ? ` for "${params.window}"` : ""} right now. ` +
          `Say so honestly, suggest they try another day, or offer to take their details so the team can arrange a time.`,
      );
    } else {
      const list = slots
        .map((s, i) => `${i + 1}. ${formatInTz(s.startsAt, timezone)} (with ${s.staffName})`)
        .join("\n");
      lines.push(
        `These times are genuinely open right now:\n${list}\n` +
          `Offer two or three of them conversationally (never as a numbered list). ` +
          `ONLY offer times from this list — no other times exist. ` +
          `To finalise a booking you need: the service they want, their name, and a phone number or email. ` +
          `Gather whichever is missing, one question at a time. ` +
          `Once the visitor has clearly agreed to one specific time AND you have their contact detail, ` +
          `the system books it automatically — do not tell them it's confirmed until the system says so.`,
      );
    }
    return lines.join("\n");
  }

  /** JSON-mode pass: what booking action is the visitor asking for right now? */
  private async extractAction(params: {
    history: ChatMessage[];
    userMessage: string;
    slots: TimeSlot[];
    existing: Appointment | null;
  }): Promise<z.infer<typeof actionSchema>> {
    const none = actionSchema.parse({});
    const { slots, existing } = params;

    // Fast path: nothing to book against and nothing to cancel.
    if (slots.length === 0 && !existing) return none;
    if (existing && CANCEL_RE.test(params.userMessage)) {
      return { ...none, action: "cancel" };
    }
    if (slots.length === 0) return none;

    const transcript = [...params.history.slice(-10), { role: "user" as const, content: params.userMessage }]
      .map((m) => `${m.role === "user" ? "Visitor" : "Receptionist"}: ${m.content}`)
      .join("\n");
    const slotList = slots.map((s, i) => `${i + 1}: ${s.startsAt}`).join("\n");

    try {
      const result = await this.llm.complete(
        buildBookingActionPrompt(),
        [
          {
            role: "user",
            content: `Open slots:\n${slotList}\n\n${existing ? `Existing appointment: ${existing.startsAt}\n\n` : ""}Transcript:\n${transcript}`,
          },
        ],
        { jsonMode: true, temperature: 0, maxTokens: 200 },
      );
      return actionSchema.parse(JSON.parse(result.content));
    } catch (error) {
      log.warn("booking action extraction failed", { error });
      return none;
    }
  }
}

/** Alternatives search horizon: a week from the requested moment. */
function horizonEnd(fromISO: string): string {
  return new Date(Date.parse(fromISO) + 7 * 86_400_000).toISOString();
}

function describe(appointment: Appointment): string {
  const when = formatInTz(appointment.startsAt, appointment.timezone);
  return `${appointment.serviceName || "appointment"} on ${when}`;
}

/** Prompt for the booking-action extraction pass. Exported for testing. */
export function buildBookingActionPrompt(): string {
  return `You watch a receptionist chat and decide whether the visitor has just committed to a scheduling action.

Return a JSON object with exactly these fields:
{"action": "none" | "book" | "cancel", "slotNumber": 0, "name": "", "phone": "", "email": "", "service": ""}

Rules:
- "book" ONLY when the visitor has clearly agreed to ONE specific time that matches an open slot (match by date and time). Set slotNumber to that slot's number. Browsing, asking questions, or "maybe" is "none".
- "cancel" ONLY when the visitor asks to cancel their existing appointment.
- name/phone/email: the visitor's own details as stated anywhere in the transcript (latest correction wins). Never invent them; leave "" if not given.
- "service": a short phrase for what the appointment is for, from the visitor's words.
- slotNumber is 0 unless action is "book".
- Respond with the JSON object only.`;
}
