import { z } from "zod";
import type { ChatMessage, LeadDraft } from "@halo/core/domain/types";
import type { LLMProvider } from "@halo/ports/llm-provider";
import { buildLeadExtractionPrompt } from "./prompt-builder";
import { logger } from "@halo/platform/logger";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
// Digits with common separators; requires 7-15 digits total (E.164 bounds).
const PHONE_RE = /(?:\+?\d[\d\s().-]{5,18}\d)/;

const extractionSchema = z.object({
  name: z.string().catch(""),
  email: z.string().catch(""),
  phone: z.string().catch(""),
  intent: z.string().catch(""),
});

function countDigits(value: string): number {
  return (value.match(/\d/g) ?? []).length;
}

/**
 * Deterministic extraction from visitor messages. Email/phone patterns are
 * reliable via regex and act as ground truth; the LLM pass adds name/intent
 * which regex cannot capture.
 */
export function extractContactsDeterministic(messages: ChatMessage[]): LeadDraft {
  const visitorText = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");

  const draft: LeadDraft = {};
  const email = visitorText.match(EMAIL_RE)?.[0];
  if (email) draft.email = email;

  const phone = visitorText.match(PHONE_RE)?.[0];
  if (phone) {
    const digits = countDigits(phone);
    if (digits >= 7 && digits <= 15) draft.phone = phone.trim();
  }
  return draft;
}

/**
 * Full extraction: LLM (JSON mode) for name + intent, regex for email +
 * phone. The regex result wins on conflict because it never hallucinates.
 * LLM failures degrade to regex-only extraction — lead capture must never
 * break the conversation.
 */
export async function extractLead(
  llm: LLMProvider,
  messages: ChatMessage[],
): Promise<LeadDraft> {
  const deterministic = extractContactsDeterministic(messages);

  const transcript = messages
    .map((m) => `${m.role === "user" ? "Visitor" : "Receptionist"}: ${m.content}`)
    .join("\n");

  let llmDraft: LeadDraft = {};
  try {
    const result = await llm.complete(
      buildLeadExtractionPrompt(),
      [{ role: "user", content: transcript }],
      { jsonMode: true, temperature: 0, maxTokens: 200 },
    );
    const parsed = extractionSchema.safeParse(JSON.parse(result.content));
    if (parsed.success) {
      llmDraft = {
        name: parsed.data.name.trim() || undefined,
        email: parsed.data.email.trim() || undefined,
        phone: parsed.data.phone.trim() || undefined,
        intent: parsed.data.intent.trim().slice(0, 200) || undefined,
      };
    }
  } catch (error) {
    logger.warn("lead extraction LLM pass failed, using regex only", { error });
  }

  return {
    name: llmDraft.name,
    intent: llmDraft.intent,
    email: deterministic.email ?? llmDraft.email,
    phone: deterministic.phone ?? llmDraft.phone,
  };
}

/** A draft is worth persisting only if it has a way to contact the visitor. */
export function isLeadWorthSaving(draft: LeadDraft): boolean {
  return Boolean(draft.email || draft.phone);
}
