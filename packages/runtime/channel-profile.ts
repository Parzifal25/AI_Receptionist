import type { ChannelProfile, ChannelProfileId } from "./contracts";

/**
 * HALO Phase 2 — channel profiles (Workstream 2).
 *
 * The runtime reads channel constraints from a profile, never from a channel
 * name. Adding a channel means adding a profile (and, later, a channel
 * adapter that renders deltas) — not a branch inside the runtime.
 *
 * Phase 2 ships two profiles for the existing web widget:
 *   - web-chat:  the typed chat surface.
 *   - web-voice: the browser speech accessory (existing behaviour: spoken
 *     replies, short, no markdown). This is NOT telephony.
 *
 * Phase 3 adds `phone-voice` for the telephony channel (voice gateway):
 * the same runtime, shorter replies, interruption, spoken-number rules and
 * language mirroring. Language-specific wording belongs in the agent's
 * persisted prompt template, not here.
 */

const WEB_TEXT_FORMATTING =
  `- Keep replies short and spoken-style: 1-3 sentences, like a person typing, not a brochure. No markdown, bullet lists, emojis or URLs unless the visitor asks for a link.
- Sound human: vary your phrasing, use contractions, and never repeat the same canned line twice in one conversation.
- Ask at most one question per reply, and only when the answer moves things forward. Never fire off a list of questions.
- Acknowledge before you ask. If someone shares a problem, respond to it before collecting details.
- Remember what the visitor already told you — never re-ask for something they've given. Match their pace: short question, short answer.
- If a message is ambiguous, ask one short clarifying question instead of guessing.
- If they correct you or you made a mistake, own it briefly and fix it — never argue.
- When the visitor's need is fully handled, close warmly and invite them back.`;

const WEB_VOICE_FORMATTING =
  `This conversation is spoken aloud. Keep every reply under two short sentences. Use plain words a listener parses instantly — no spelled-out URLs or symbols. Spell out numbers naturally ("nine to five", not "09:00-17:00"). When taking a phone number or email, read it back to confirm. If interrupted or the visitor talks over you, drop your point and respond to theirs.`;

export const WEB_CHAT_PROFILE: ChannelProfile = Object.freeze({
  id: "web-chat",
  channel: "web",
  modality: "text",
  maxReplyChars: 2400,
  supportsMarkdown: false,
  supportsInterruption: false,
  requiresConfirmationForSideEffects: true,
  allowsToolExecution: true,
  latencySensitivity: "normal",
  formattingRules: WEB_TEXT_FORMATTING,
  spokenDeliveryRules: null,
});

export const WEB_VOICE_PROFILE: ChannelProfile = Object.freeze({
  id: "web-voice",
  channel: "web",
  modality: "voice",
  maxReplyChars: 600,
  supportsMarkdown: false,
  supportsInterruption: true,
  requiresConfirmationForSideEffects: true,
  allowsToolExecution: true,
  latencySensitivity: "high",
  formattingRules: WEB_TEXT_FORMATTING,
  spokenDeliveryRules: WEB_VOICE_FORMATTING,
});

/**
 * Phone delivery is ONE block, not two.
 *
 * Until Sprint 2 the phone profile rendered `formattingRules` as
 * "## How you converse" and `spokenDeliveryRules` as "## Voice mode", and the
 * two said three of the same things: say it the way a person says it aloud,
 * what to do when the caller interrupts, and act-then-narrate. The last of
 * those is the Rules section's job and is stated there in stronger terms, so
 * restating it here bought nothing and cost a section. The two rules that were
 * ONLY in the spoken block — read a number back before relying on it, and drop
 * your point when the caller talks over you — are kept verbatim below.
 */
const PHONE_FORMATTING =
  `- This is a live phone call. Speak like a person on the phone: one or two short sentences, then stop and let the caller talk.
- Reply in the language the caller is using. If they mix languages (for example Telugu with English words), mirror that mix naturally and keep technical terms the way the caller says them.
- Ask exactly one question per turn, and only the question the conversation needs next.
- Never read out lists, symbols, URLs or formatting. Say numbers, dates and times the way a person says them aloud.
- Read phone numbers, amounts, dates and times back to the caller and ask them to confirm before relying on them.
- If you did not clearly understand a name, number or place, say so briefly and ask the caller to repeat it — never guess.
- If the caller interrupts you, drop your point and respond to what they said.`;

export const PHONE_VOICE_PROFILE: ChannelProfile = Object.freeze({
  id: "phone-voice",
  channel: "phone",
  modality: "voice",
  maxReplyChars: 450,
  supportsMarkdown: false,
  supportsInterruption: true,
  requiresConfirmationForSideEffects: true,
  allowsToolExecution: true,
  latencySensitivity: "high",
  formattingRules: PHONE_FORMATTING,
  // Merged into formattingRules above: a phone turn gets one delivery block.
  spokenDeliveryRules: null,
});

const PROFILES: Record<ChannelProfileId, ChannelProfile> = {
  "web-chat": WEB_CHAT_PROFILE,
  "web-voice": WEB_VOICE_PROFILE,
  "phone-voice": PHONE_VOICE_PROFILE,
};

export function channelProfile(id: ChannelProfileId): ChannelProfile {
  return PROFILES[id];
}

/**
 * Maps the conversation row's channel ("chat" | "voice" — the widget's
 * modality field) onto a profile. Kept here so no caller branches on it.
 */
export function channelProfileForConversation(channel: "chat" | "voice" | undefined): ChannelProfile {
  return channel === "voice" ? WEB_VOICE_PROFILE : WEB_CHAT_PROFILE;
}
