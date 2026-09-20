import type { ActionRecord } from "@halo/runtime/contracts";
import type { ConversationStatePatch } from "@halo/runtime/conversation-state";
import type { SystemActionInput, SystemActionOutcome, SystemActionProvider } from "@halo/runtime/system-actions";
import type { LanguagePack } from "@halo/language/language-pack";
import type { BillRanges } from "@halo/language/parsers/bill";
import {
  applyUtterance,
  emptySnapshot,
  fieldById,
  isTerminal,
  qualificationPayload,
  type QualificationEvent,
  type QualificationSnapshot,
} from "./engine";
import type { QualificationSchema } from "./schema";

/**
 * HALO Phase 4 — qualification as a runtime SYSTEM ACTION (act-then-narrate).
 *
 * The engine runs BEFORE the model on every turn and hands it verified ground
 * truth: what has been collected, what must be asked next (the tenant's own
 * question, in the tenant's language) and what must be confirmed. The model
 * only phrases it. Deterministic state lives outside the model — in this
 * provider and in `conversation_state` — never in the transcript.
 *
 * The provider instance lives for one conversation (one call).
 */

export const QUALIFICATION_CLOSED_STEP = "closed";

export interface QualificationProviderDeps {
  schema: QualificationSchema;
  pack: LanguagePack;
  billRanges?: BillRanges;
  /** Voice signals for the current turn (STT confidence), when on a call. */
  signals?: () => { sttConfidence: number | null };
  /** Below this STT confidence, a captured value is always confirmed back. */
  lowConfidenceThreshold?: number;
  onUpdate?: (snapshot: QualificationSnapshot, events: QualificationEvent[]) => void;
}

export class QualificationSystemActionProvider implements SystemActionProvider {
  readonly name = "qualification";
  private snapshot: QualificationSnapshot = emptySnapshot();

  constructor(private readonly deps: QualificationProviderDeps) {}

  current(): QualificationSnapshot {
    return this.snapshot;
  }

  /** Restores a snapshot (e.g. after a process restart). */
  restore(snapshot: QualificationSnapshot): void {
    this.snapshot = snapshot;
  }

  async prepare(input: SystemActionInput): Promise<SystemActionOutcome | null> {
    const before = this.snapshot;
    const { snapshot, events } = applyUtterance(
      { schema: this.deps.schema, pack: this.deps.pack, billRanges: this.deps.billRanges },
      before,
      input.userMessage,
    );

    // A value captured from a poorly-heard utterance is always read back,
    // whatever the parser thought (plan §P8.14: never guess names or numbers).
    const sttConfidence = this.deps.signals?.().sttConfidence ?? null;
    const threshold = this.deps.lowConfidenceThreshold ?? 0.6;
    if (
      sttConfidence !== null &&
      sttConfidence < threshold &&
      !snapshot.awaitingConfirmationFieldId &&
      events.some((e) => e.type === "captured")
    ) {
      const captured = [...events].reverse().find((e) => e.type === "captured");
      if (captured && captured.type === "captured" && !snapshot.fields[captured.field]?.confirmed) {
        snapshot.awaitingConfirmationFieldId = captured.field;
        events.push({ type: "confirmation_requested", field: captured.field, value: captured.value });
      }
    }

    this.snapshot = snapshot;
    this.deps.onUpdate?.(snapshot, events);

    const sections = [this.renderSection(snapshot)];
    const actions: ActionRecord[] = [];
    const statePatch: ConversationStatePatch = {
      qualification: qualificationSlots(snapshot),
      workflowStep: isTerminal(snapshot.status) || snapshot.status === "complete" ? QUALIFICATION_CLOSED_STEP : "qualifying",
      intent: snapshot.status === "in_progress" ? "qualification" : snapshot.status,
    };
    return { sections, actions, statePatch };
  }

  /** The ground-truth prompt section. Tenant content only; no invented facts. */
  private renderSection(snapshot: QualificationSnapshot): string {
    const language = this.deps.schema.language;
    const lines: string[] = ["Qualification (managed by the system — this is verified ground truth, not a suggestion):"];

    const collected = Object.entries(snapshot.fields)
      .filter(([, value]) => !value.unknown)
      .map(([id, value]) => `${id} = ${value.value}${value.confirmed ? " (confirmed)" : " (not yet confirmed)"}`);
    lines.push(collected.length > 0 ? `- Already collected: ${collected.join("; ")}.` : "- Nothing collected yet.");
    const unknown = Object.entries(snapshot.fields).filter(([, v]) => v.unknown).map(([id]) => id);
    if (unknown.length > 0) lines.push(`- The caller does not know: ${unknown.join(", ")}. Do not ask these again.`);

    if (snapshot.status === "do_not_call") {
      lines.push("- The caller asked not to be contacted again. Acknowledge this respectfully, apologise briefly for the disturbance, and end the call. Do not ask anything else.");
      return lines.join("\n");
    }
    if (snapshot.status === "wrong_number") {
      lines.push("- Wrong number. Apologise briefly and end the call. Ask nothing else.");
      return lines.join("\n");
    }
    if (snapshot.status === "callback_requested") {
      lines.push("- The caller cannot talk now. Say the team will call back at a better time, thank them, and end the call.");
      return lines.join("\n");
    }
    if (snapshot.status === "disqualified") {
      lines.push(
        `- This caller does not qualify (${snapshot.disqualifiedReason}). Close the call warmly and honestly. ` +
          "Do not pitch, do not promise anything, and do not offer a visit.",
      );
      return lines.join("\n");
    }

    if (snapshot.awaitingConfirmationFieldId) {
      const field = fieldById(this.deps.schema, snapshot.awaitingConfirmationFieldId);
      const value = snapshot.fields[snapshot.awaitingConfirmationFieldId];
      const prompt = field?.confirmPrompts?.[language];
      lines.push(
        `- CONFIRM THIS AND NOTHING ELSE: read back "${value?.value ?? ""}" and ask the caller to confirm it is right.` +
          (prompt ? ` Say it like this, in the caller's language: "${prompt.replace("{value}", value?.value ?? "")}"` : ""),
      );
      return lines.join("\n");
    }

    if (snapshot.status === "complete") {
      lines.push("- Everything needed has been collected. Do not ask further qualification questions.");
      return lines.join("\n");
    }

    if (snapshot.pendingFieldId) {
      const field = fieldById(this.deps.schema, snapshot.pendingFieldId);
      const question = field?.questions[language] ?? field?.questions[Object.keys(field.questions)[0]];
      const attempt = snapshot.attempts[snapshot.pendingFieldId] ?? 0;
      lines.push(
        `- ASK EXACTLY THIS NEXT, and only this: "${question}"` +
          (attempt > 0 ? " The caller's previous answer was not understood — ask again, more simply, and do not guess." : ""),
      );
    }
    if (snapshot.humanRequested) {
      lines.push("- The caller asked for a person (or too much went unanswered). Acknowledge it directly.");
    }
    return lines.join("\n");
  }
}

/** Bounded, string-only values for `conversation_state.qualification`. */
export function qualificationSlots(snapshot: QualificationSnapshot): Record<string, string> {
  const slots: Record<string, string> = {};
  for (const [id, value] of Object.entries(snapshot.fields)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(id)) continue;
    slots[id] = (value.unknown ? "unknown" : value.value).slice(0, 240);
  }
  return slots;
}

export { qualificationPayload };
