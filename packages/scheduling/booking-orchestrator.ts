import "server-only";
import { z } from "zod";
import type { Business, ChatMessage } from "@halo/core/domain/types";
import type { Appointment, TimeSlot } from "@halo/core/domain/scheduling";
import type { LLMProvider } from "@halo/ports/llm-provider";
import { BookingService } from "./booking-service";
import { SchedulingRepository } from "./scheduling-repository";
import {
  commitSlot,
  describeDraft,
  describeMissingField,
  extractDraftFromMessage,
  hasDraftContent,
  mergeDraft,
  missingFields,
  resolveSlot,
  EMPTY_DRAFT,
  type BookingDraft,
  type MissingField,
} from "./booking-draft";
import { dateStringInTz, formatInTz, hourInTz } from "./timezone";
import { parseWhen } from "./when-parser";
import { getLLMProvider } from "@halo/providers/llm/factory";
import { logger } from "@halo/platform/logger";

const log = logger.child({ service: "booking-orchestrator" });

/** Messages that put the conversation into scheduling context. */
const SCHEDULING_INTENT_RE =
  /\b(book|booking|appointment|schedule|reschedule|re-book|rebook|cancel|availab|opening|slot|come in|fit me in|see (?:me|us)|visit)\b/i;

const CANCEL_RE = /\b(cancel|call (it )?off|can't make|cannot make|won't make)\b/i;

/**
 * Deterministic "yes, that time" signals. The LLM extraction pass is the
 * primary commitment detector; this backstops it so an outage or a malformed
 * JSON reply can't strand a visitor who already said "book it".
 */
const COMMITMENT_RE =
  /\b(book it|book me|that works|works for me|sounds good|let'?s do|lock (it|that) in|go ahead|yes please|confirm|i'?ll take|take that|perfect|instead|change it to|move it to|make it)\b/i;

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
  notes: z.string().catch(""),
});

/**
 * What the engine actually did this turn — the typed counterpart of the
 * prompt section, consumed by the Agent Runtime to decide which action
 * claims the reply may make (act → verify → narrate).
 */
export type BookingTurnOutcome =
  | { kind: "booked"; hasExistingAppointment: false }
  | { kind: "rescheduled"; hasExistingAppointment: true }
  | { kind: "cancelled"; hasExistingAppointment: false }
  | { kind: "failed"; reason: "slot_taken" | "invalid"; wasReschedule: boolean; hasExistingAppointment: boolean }
  | { kind: "unchanged"; hasExistingAppointment: true }
  | { kind: "guidance"; hasExistingAppointment: boolean }
  | { kind: "nothing_to_cancel"; hasExistingAppointment: false };

export interface BookingTurnContext {
  /** Extra system-prompt section for this turn (availability, booking result). */
  promptSection: string;
  /** True when an appointment was just booked/moved — forces lead capture. */
  bookedNow: boolean;
  /** Typed outcome (Phase 2). Optional for hand-built fakes; derived from bookedNow when absent. */
  outcome?: BookingTurnOutcome;
}

/**
 * Bridges conversation and the booking engine.
 *
 * The unit of state is the *draft appointment* (see `booking-draft.ts`),
 * carried across the whole conversation: every turn merges what the visitor
 * just said into it — deterministically first, LLM extraction second — so a
 * message carrying four details fills four fields and nothing has to be
 * asked twice.
 *
 * Order of operations inside a turn: load the draft → update it from this
 * message → fetch real slots → resolve the agreed time against those slots →
 * call the engine the moment the draft is complete → hand the *result* to
 * the reply model.
 *
 * Two invariants hold everywhere below, because they are what visitors get
 * burned by:
 *   1. Nothing is ever described as booked unless `BookingService` returned
 *      `ok: true` this turn. Every other branch says so explicitly.
 *   2. Only facts the engine returned reach the prompt — real slots, the
 *      real failure reason, the real existing appointment. The model
 *      narrates ground truth; it never invents times, policies or outcomes.
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
    const timezone = settings.timezone;

    const stored = await this.repository.getBookingDraft(conversationId);
    const existing = await this.repository.findLiveAppointmentByConversation(conversationId);

    const recentVisitorText = [
      ...history.filter((m) => m.role === "user").slice(-CONTEXT_TURNS).map((m) => m.content),
      userMessage,
    ].join("\n");

    // Real availability for the window the visitor asked about. A time
    // expression alone ("AC servicing tomorrow") is scheduling intent even
    // without a booking keyword — and so is an in-flight draft, which keeps
    // "John, 555-0100" in scheduling context on its own.
    const window =
      parseWhen(userMessage, now, timezone) ?? parseWhen(recentVisitorText, now, timezone);
    const inSchedulingContext =
      SCHEDULING_INTENT_RE.test(recentVisitorText) || window !== null || hasDraftContent(stored);

    if (!inSchedulingContext && !existing) return null;

    // A cancellation request with nothing to cancel must never be answered
    // as though something was cancelled.
    if (!existing && CANCEL_RE.test(userMessage)) {
      return {
        promptSection: NOTHING_TO_CANCEL_SECTION,
        bookedNow: false,
        outcome: { kind: "nothing_to_cancel", hasExistingAppointment: false },
      };
    }

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

    // What did this message change, and what does the visitor want done?
    // Deterministic extraction is applied last so regex-verified contact
    // details always beat the model's reading of them.
    const action = await this.extractAction({ history, userMessage, slots, existing, draft: stored });

    if (action.action === "cancel" && existing) {
      await this.booking.cancel({ business, appointment: existing, reason: "Visitor asked in chat" });
      await this.repository.clearBookingDraft(conversationId);
      return {
        promptSection:
          `## Booking status\n` +
          `You have JUST cancelled the visitor's appointment (${describe(existing)}). ` +
          `Confirm the cancellation warmly, and offer to find them a new time if they'd like.`,
        bookedNow: false,
        outcome: { kind: "cancelled", hasExistingAppointment: false },
      };
    }

    let draft = mergeDraft(stored ?? EMPTY_DRAFT, {
      service: action.service,
      name: action.name,
      phone: action.phone,
      email: action.email,
      notes: action.notes,
    });
    draft = mergeDraft(draft, extractDraftFromMessage(userMessage, now, timezone));

    // A visitor who repeats themselves — a resend, a double tap, "so that's
    // 9am on Tuesday?" — is naming the time they already hold. Their own slot
    // is no longer in the open list, so anything further down this method
    // would read them as asking for a different time and quietly move the
    // appointment. Say what stands instead.
    if (existing && draft.time && namesTimeOf(existing, draft, timezone)) {
      return {
        promptSection:
          `## Booking status\n` +
          `Nothing has changed: the visitor already has this exact appointment — ${describe(existing)}. ` +
          `Reassure them it is confirmed and on the books, in one sentence. Do NOT book anything new, ` +
          `do NOT move it, and do not ask for their details again.`,
        bookedNow: false,
        outcome: { kind: "unchanged", hasExistingAppointment: true },
      };
    }

    // Which real slot (if any) is the visitor pointing at, and have they
    // actually agreed to it? An agreed time is pinned onto the draft so a
    // later turn that only supplies a phone number can still book it.
    //
    // The visitor's own words outrank the model's slot number: a list that
    // re-indexed between turns must never turn "9am" into 10am. When they
    // named a time we couldn't match to an open slot, nothing is picked —
    // they get asked, not booked into something they never said.
    const picked =
      resolveSlot(draft, slots, timezone) ??
      (!draft.time && action.slotNumber >= 1 && action.slotNumber <= slots.length
        ? slots[action.slotNumber - 1]
        : null);
    const agreed =
      action.action === "book" || COMMITMENT_RE.test(userMessage) || draft.timeCommitted;
    if (picked && agreed) draft = commitSlot(draft, picked, timezone);

    const slot = draft.timeCommitted ? picked : null;

    // Rescheduling inherits the visitor's details from the appointment
    // itself, so an agreed new time is all it needs.
    if (existing && slot) {
      return this.executeBooking({ business, conversationId, slot, draft, existing, timezone, now });
    }

    const missing = missingFields(draft, Boolean(slot));
    if (!existing && slot && missing.length === 0) {
      return this.executeBooking({ business, conversationId, slot, draft, existing: null, timezone, now });
    }

    // Not bookable yet — remember everything gathered so far and tell the
    // model precisely what it already knows and what to ask next.
    await this.repository.saveBookingDraft(business.id, conversationId, draft);
    return {
      promptSection: this.guidanceSection({
        draft,
        missing,
        slots,
        existing,
        timezone,
        window: window?.label,
        requestedTimeUnavailable,
      }),
      bookedNow: false,
      outcome: { kind: "guidance", hasExistingAppointment: existing !== null },
    };
  }

  /**
   * Calls the engine and reports exactly what it returned. Success clears
   * the draft; a failure keeps it (minus the time that didn't work) so the
   * conversation can recover without re-collecting the visitor's details.
   */
  private async executeBooking(params: {
    business: Business;
    conversationId: string;
    slot: TimeSlot;
    draft: BookingDraft;
    existing: Appointment | null;
    timezone: string;
    now: Date;
  }): Promise<BookingTurnContext> {
    const { business, conversationId, slot, draft, existing, timezone, now } = params;

    const result = existing
      ? await this.booking.reschedule({ business, appointment: existing, slot, now })
      : await this.booking.book({
          business,
          conversationId,
          slot,
          serviceName: draft.service,
          visitorName: draft.name,
          visitorPhone: draft.phone,
          visitorEmail: draft.email,
          notes: draft.notes,
          now,
        });

    if (result.ok) {
      await this.repository.clearBookingDraft(conversationId);
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
        outcome: existing
          ? { kind: "rescheduled", hasExistingAppointment: true }
          : { kind: "booked", hasExistingAppointment: false },
      };
    }

    // The booking did NOT happen. Keep what the visitor gave us — including
    // the day, which is still the day they want — and drop only the time
    // that failed, so the next turn re-agrees a time rather than restarting.
    await this.repository.saveBookingDraft(business.id, conversationId, {
      ...draft,
      time: "",
      timeCommitted: false,
    });

    if (result.reason === "slot_taken") {
      const alternatives = result.alternatives
        .map((s, i) => `${i + 1}. ${formatInTz(s.startsAt, timezone)}`)
        .join("\n");
      return {
        promptSection:
          `## Booking status\n` +
          `The booking FAILED: the time the visitor chose (${formatInTz(slot.startsAt, timezone)}) ` +
          `was just taken by someone else. Apologise briefly, tell them plainly that it did not go ` +
          `through, and do NOT pretend it is booked. ` +
          (alternatives
            ? `Offer these real alternatives instead:\n${alternatives}`
            : `There are no nearby alternatives — offer to have the team call them to find a time.`) +
          `\nEverything else they told you is still on file — do not re-ask for their details.`,
        bookedNow: false,
        outcome: {
          kind: "failed",
          reason: "slot_taken",
          wasReschedule: existing !== null,
          hasExistingAppointment: existing !== null,
        },
      };
    }

    return {
      promptSection:
        `## Booking status\n` +
        `The booking FAILED and no appointment exists. Reason given by the system: ${result.message}. ` +
        `Tell the visitor honestly that it didn't go through and why, in one short sentence, using ` +
        `only that reason — do not invent a different explanation or any policy. ` +
        `Then offer to try another time from the list above, or to have the team call them. ` +
        `Never say or imply the appointment is confirmed.`,
      bookedNow: false,
      outcome: {
        kind: "failed",
        reason: "invalid",
        wasReschedule: existing !== null,
        hasExistingAppointment: existing !== null,
      },
    };
  }

  /**
   * The mid-booking prompt section: verified availability, the draft so far,
   * and the single next thing to ask. Showing the model what it already
   * knows is what stops the "and can I take your name?" loop.
   */
  private guidanceSection(params: {
    draft: BookingDraft;
    missing: MissingField[];
    slots: TimeSlot[];
    existing: Appointment | null;
    timezone: string;
    window?: string;
    /** The visitor's exact requested time is booked; slots are alternatives. */
    requestedTimeUnavailable?: boolean;
  }): string {
    const { draft, missing, slots, existing, timezone } = params;
    const lines: string[] = ["## Live scheduling (system-verified, this moment)"];

    if (existing) {
      lines.push(
        `The visitor already has an appointment: ${describe(existing)}. ` +
          `If they want to change or cancel it, help with that.`,
      );
    }

    const known = describeDraft(draft, timezone);
    if (known) {
      lines.push(
        `The visitor has ALREADY given you these details — use them, and never ask for ` +
          `any of them again:\n${known}`,
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
          `ONLY offer times from this list — no other times exist.`,
      );
    }

    // `missing` always holds at least the time here: a draft with nothing
    // missing has already been sent to the engine.
    lines.push(
      `Still needed before this can be booked: ${missing.join(", ")}. ` +
        `Ask for ONE thing next — ${describeMissingField(missing[0])} — in a single natural sentence ` +
        `that acknowledges what they just said. Do not present a checklist.`,
    );

    lines.push(
      `The appointment is NOT booked. The system books it automatically the moment the details ` +
        `above are complete and the visitor has agreed to one of these times, and it will tell you ` +
        `in a "Booking status" section when that has happened. Until then you must not say or imply ` +
        `it is booked, confirmed, held or reserved. ` +
        `State nothing about prices, policies, staff, or what the team will do that is not in the ` +
        `information you were given — if you don't have it, say you'll have the team confirm.`,
    );
    return lines.join("\n");
  }

  /**
   * JSON-mode pass: what did the visitor just ask for, and which of their
   * details changed? Only *new or corrected* values come back, which keeps
   * the draft authoritative and the output small.
   */
  private async extractAction(params: {
    history: ChatMessage[];
    userMessage: string;
    slots: TimeSlot[];
    existing: Appointment | null;
    draft: BookingDraft | null;
  }): Promise<z.infer<typeof actionSchema>> {
    const none = actionSchema.parse({});
    const { slots, existing, draft } = params;

    if (existing && CANCEL_RE.test(params.userMessage)) {
      return { ...none, action: "cancel" };
    }

    const transcript = [...params.history.slice(-10), { role: "user" as const, content: params.userMessage }]
      .map((m) => `${m.role === "user" ? "Visitor" : "Receptionist"}: ${m.content}`)
      .join("\n");
    const slotList =
      slots.length > 0
        ? slots.map((s, i) => `${i + 1}: ${s.startsAt}`).join("\n")
        : "(none open in the window they asked about)";
    const draftText = draft ? describeDraft(draft, "the business timezone") : "";

    try {
      const result = await this.llm.complete(
        buildBookingActionPrompt(),
        [
          {
            role: "user",
            content:
              `Open slots:\n${slotList}\n\n` +
              (draftText ? `Already collected:\n${draftText}\n\n` : "") +
              (existing ? `Existing appointment: ${existing.startsAt}\n\n` : "") +
              `Transcript:\n${transcript}`,
          },
        ],
        { jsonMode: true, temperature: 0, maxTokens: 250 },
      );
      return actionSchema.parse(JSON.parse(result.content));
    } catch (error) {
      // Extraction is an accelerant, not a dependency: the deterministic
      // pass still updates the draft and the turn continues.
      log.warn("booking action extraction failed", { error });
      return none;
    }
  }
}

/** Told to the model when a visitor cancels an appointment we have no record of. */
const NOTHING_TO_CANCEL_SECTION =
  `## Booking status\n` +
  `The visitor asked to cancel, but this conversation has NO appointment on file, so nothing ` +
  `has been cancelled and you must not say anything has. Say honestly that you can't see a ` +
  `booking under this chat, and offer to check it with the team if they give you their name ` +
  `and the day it was for.`;

/** Alternatives search horizon: a week from the requested moment. */
function horizonEnd(fromISO: string): string {
  return new Date(Date.parse(fromISO) + 7 * 86_400_000).toISOString();
}

/** Whether the draft's day/time is the one the appointment already holds. */
function namesTimeOf(
  appointment: Appointment,
  draft: BookingDraft,
  timezone: string,
): boolean {
  const startsAt = new Date(appointment.startsAt);
  if (draft.date && dateStringInTz(startsAt, timezone) !== draft.date) return false;
  const hour = Math.floor(hourInTz(startsAt, timezone));
  return Number(draft.time.split(":")[0]) === hour;
}

function describe(appointment: Appointment): string {
  const when = formatInTz(appointment.startsAt, appointment.timezone);
  return `${appointment.serviceName || "appointment"} on ${when}`;
}

/** Prompt for the booking-action extraction pass. Exported for testing. */
export function buildBookingActionPrompt(): string {
  return `You watch a receptionist chat and report what the visitor has just asked for.

Return a JSON object with exactly these fields:
{"action": "none" | "book" | "cancel", "slotNumber": 0, "name": "", "phone": "", "email": "", "service": "", "notes": ""}

Rules:
- "book" ONLY when the visitor has clearly agreed to ONE specific time that matches an open slot (match by date and time). Set slotNumber to that slot's number. Browsing, asking whether a time is free, or "maybe" is "none".
- "cancel" ONLY when the visitor asks to cancel their existing appointment.
- name/phone/email: the visitor's own details as stated anywhere in the transcript. If the visitor gave several details in one message, return all of them. If they corrected a detail, return the latest version. Never invent them; leave "" if not given.
- "service": a short phrase for what the appointment is for, from the visitor's words.
- "notes": anything they asked us to note for the visit (access instructions, symptoms, "bringing my son"). "" if none.
- Leave a field "" when the visitor has not mentioned it — an empty field keeps what was already collected, it never erases it.
- slotNumber is 0 unless action is "book".
- Respond with the JSON object only.`;
}
