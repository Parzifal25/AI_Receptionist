import { detectLanguage, type LanguageCode, type LanguageDetection } from "./detect";
import { ENGLISH_LEXICON, TELUGU_LEXICON, matchIntents, type IntentLexicon, type IntentMatch, type IntentName } from "./lexicon";
import { readElectricityBill, type BillRanges, type BillReading } from "./parsers/bill";
import { extractName, parseIndianMobile, parsePincode, type ParsedName, type ParsedPhone, type ParsedPincode } from "./parsers/contact";
import { parseNumber, type ParsedNumber } from "./parsers/numerals";
import { parseCapacityKw, type ParsedCapacity } from "./parsers/quantity";
import { hasTimeExpression, toEnglishTimeGloss } from "./parsers/time-expressions";

/**
 * HALO Phase 4 — the language pack (plan §P3.6).
 *
 * One object per supported language carrying every deterministic
 * language-dependent behaviour. Selecting a pack for an unsupported language
 * DEGRADES LOUDLY: `supported: false` plus a reason the caller must log and
 * meter, and the deterministic layer is explicitly reduced rather than
 * silently no-opping (the failure mode the audit found everywhere).
 */

export interface LanguagePack {
  code: LanguageCode;
  /** BCP-47 tags this pack serves ("te", "te-IN", "te-en"). */
  tags: string[];
  lexicon: IntentLexicon;
  detect(text: string): LanguageDetection;
  intents(text: string): IntentMatch[];
  has(text: string, intent: IntentName): boolean;
  number(text: string): ParsedNumber | null;
  bill(text: string, ranges?: BillRanges): BillReading;
  capacity(text: string): ParsedCapacity | null;
  phone(text: string): ParsedPhone | null;
  pincode(text: string): ParsedPincode | null;
  name(text: string): ParsedName | null;
  /** English gloss of time language, for the scheduling engine's parser. */
  timeGloss(text: string): string;
  hasTime(text: string): boolean;
}

function pack(code: LanguageCode, tags: string[], lexicon: IntentLexicon): LanguagePack {
  return {
    code,
    tags,
    lexicon,
    detect: detectLanguage,
    intents: (text) => matchIntents(text, lexicon),
    has: (text, intent) => matchIntents(text, lexicon).some((m) => m.intent === intent),
    number: parseNumber,
    bill: (text, ranges) => readElectricityBill(text, ranges),
    capacity: parseCapacityKw,
    phone: parseIndianMobile,
    pincode: parsePincode,
    name: extractName,
    timeGloss: toEnglishTimeGloss,
    hasTime: hasTimeExpression,
  };
}

export const TELUGU_PACK = pack("te", ["te", "te-in", "te-en"], TELUGU_LEXICON);
export const ENGLISH_PACK = pack("en", ["en", "en-in", "en-us", "en-gb"], ENGLISH_LEXICON);

const PACKS = [TELUGU_PACK, ENGLISH_PACK];

export interface PackSelection {
  pack: LanguagePack;
  supported: boolean;
  /** Set when the requested language has no pack: log and meter this. */
  downgrade?: { requested: string; servedBy: LanguageCode; reason: "no_language_pack" };
}

/**
 * The pack for a configured language tag. An unsupported language falls back
 * to English WITH an explicit downgrade record — never silently.
 */
export function selectLanguagePack(tag: string): PackSelection {
  const normalized = tag.trim().toLowerCase();
  const found = PACKS.find((p) => p.tags.includes(normalized) || p.tags.includes(normalized.split("-")[0]));
  if (found) return { pack: found, supported: true };
  return {
    pack: ENGLISH_PACK,
    supported: false,
    downgrade: { requested: tag, servedBy: ENGLISH_PACK.code, reason: "no_language_pack" },
  };
}

export const SUPPORTED_LANGUAGE_TAGS = PACKS.flatMap((p) => p.tags);
