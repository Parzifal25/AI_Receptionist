/**
 * Text and audio shaping for the local (Piper) TTS — HALO Phase B.
 *
 * The Piper voices read raw text through espeak-ng, which says a phone number
 * as one huge cardinal, treats "Dr." and "Rs." as sentence ends, and reads
 * "10:30 AM" in whatever language the voice happens to be. Sarvam is called
 * with its own preprocessing disabled, so nothing upstream fixes this either.
 *
 * 1. `normalizeForSpeech` writes numbers, dates, times, prices, units and
 *    common abbreviations out as words, in the language of the words around
 *    them (next to Telugu in Telugu, next to English in English, otherwise in
 *    the line's language). Booking codes (`AR-2041`) are spelled character by
 *    character in English.
 * 2. `planSpeech` cuts the line into synthesis segments: one per sentence,
 *    long sentences at clause punctuation (never inside a phone number or a
 *    date), then by script. Each segment carries the pause that follows it.
 * 3. `trimAndFade` / `pauseSamples` join the segments: each segment's own
 *    edge silence is trimmed, its edges faded, and an explicit pause
 *    inserted, so a voice switch mid-phrase is not a quarter-second gap.
 *
 * The Python twin is services/pipecat-worker/local_tts_text.py. Both must
 * produce the same output for tests/fixtures/local-tts-text-cases.json.
 * Telugu renderings are engineering choices, not reviewed by a native
 * speaker; see docs/LOCAL_SPEECH_BENCHMARK.md (Phase B.5).
 */

export type PauseKind = "sentence" | "clause" | "switch";
export interface SpeechSegment { language: string; text: string; pause: PauseKind }

/** Pause after a segment, by how the segment ends (see planSpeech). */
export const PAUSE_MS: Readonly<Record<PauseKind, number>> = Object.freeze({ sentence: 280, clause: 160, switch: 40 });
/** Trim threshold (linear amplitude), silence kept at each trimmed edge, fade length. */
export const SHAPE_DEFAULTS = Object.freeze({ trimThreshold: 0.01, keepMs: 25, fadeMs: 5 });
/** Speed used when HALO names no speaking rate, per voice language. */
export const DEFAULT_SPEED: Readonly<Record<string, number>> = Object.freeze({});
const CLAUSE_SPLIT_CHARS = 60, CLAUSE_MIN_CHARS = 25;

/** A comma that must not become a segment boundary (inside a phone number or a date). */
const KEEP = "";

/** No installed voice can speak a run of the text. */
export class UnspeakableTextError extends Error {}

const UNITS_TE = ["సున్నా", "ఒకటి", "రెండు", "మూడు", "నాలుగు", "ఐదు", "ఆరు", "ఏడు", "ఎనిమిది", "తొమ్మిది", "పది",
  "పదకొండు", "పన్నెండు", "పదమూడు", "పద్నాలుగు", "పదిహేను", "పదహారు", "పదిహేడు", "పద్దెనిమిది", "పంతొమ్మిది"];
const TENS_TE = ["", "", "ఇరవై", "ముప్పై", "నలభై", "యాభై", "అరవై", "డెబ్బై", "ఎనభై", "తొంభై"];
const UNITS_EN = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS_EN = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_TE = ["జనవరి", "ఫిబ్రవరి", "మార్చి", "ఏప్రిల్", "మే", "జూన్", "జూలై", "ఆగస్టు", "సెప్టెంబర్", "అక్టోబర్", "నవంబర్", "డిసెంబర్"];
const LETTERS_EN: Record<string, string> = { A: "ay", B: "bee", C: "see", D: "dee", E: "ee", F: "ef", G: "jee", H: "aitch", I: "eye", J: "jay",
  K: "kay", L: "el", M: "em", N: "en", O: "oh", P: "pee", Q: "cue", R: "ar", S: "es", T: "tee", U: "you", V: "vee", W: "double you",
  X: "ex", Y: "why", Z: "zed" };
/** Said before a time when it carries no AM/PM word of its own. */
const PERIOD_WORDS_TE = new Set(["ఉదయం", "మధ్యాహ్నం", "సాయంత్రం", "రాత్రి", "తెల్లవారుజామున"]);
/** Telugu words that join the number before them ("గంటలు" + "కి" → "గంటలకు"). */
const MERGE_SUFFIXES_TE = new Set(["కి", "కు", "లో", "న"]);
/** Postpositions that take the oblique form ("గంటలు" → "గంటల తర్వాత"). */
const POSTPOSITIONS_TE = new Set(["వరకు", "నుంచి", "నుండి", "తర్వాత", "ముందు", "లోపు", "కోసం", "దాకా"]);
/** Nouns a number qualifies: the number takes its attributive form ("ఒక గంట", "రెండు వేల మంది"). */
const NOUNS_TE = new Set(["రూపాయలు", "రూపాయల", "రూపాయి", "మంది", "రోజు", "రోజులు", "రోజుల", "గంట", "గంటలు", "గంటల", "నిమిషం",
  "నిమిషాలు", "నిమిషాల", "సంవత్సరం", "సంవత్సరాలు", "సంవత్సరాల", "నెల", "నెలలు", "నెలల", "వారం", "వారాలు",
  "యూనిట్లు", "యూనిట్ల", "ప్యానెల్స్"]);

const ABBREVIATIONS: [RegExp, string][] = [
  [/(?<![A-Za-z])Dr\.(?= )/g, "Doctor"],
  [/(?<![A-Za-z])Mrs\.(?= )/g, "Missus"],
  [/(?<![A-Za-z])Mr\.(?= )/g, "Mister"],
  [/(?<![A-Za-z])Ms\.(?= )/g, "Miz"],
  [/(?<![A-Za-z])Sr\. ?No\./g, "serial number"],
  [/(?<![A-Za-z])No\.(?= ?(?:[0-9]|[A-Z]{1,4}-?[0-9]))/g, "number"],
  [/(?<![A-Za-z])Ref\.(?= )/g, "reference"],
  [/(?<![A-Za-z])Opp\.(?= )/g, "opposite"],
  [/(?<![A-Za-z])Appt\.(?= )/g, "appointment"],
  [/(?<![A-Za-z])Mob(?:\.(?= )|(?=:))/g, "mobile"],
  [/(?<![A-Za-z])Ph(?:\.(?= )|(?=:))/g, "phone"],
  // "Rd." after a name; its dot stays a sentence end unless lower case, a digit or a comma follows.
  [/(?<=[A-Za-z] )Rd\.(?= [a-z0-9]|,)/g, "Road"],
  [/(?<=[A-Za-z] )Rd\./g, "Road."],
  [/(?<=[A-Za-z] )Rd(?![A-Za-z.])/g, "Road"],
  [/(?<![A-Za-z])Pvt\. Ltd\./g, "Private Limited"],
  [/(?<![A-Za-z])Ltd\./g, "Limited"],
  [/(?<![A-Za-z])e\.g\.,?/g, "for example,"],
  [/(?<![A-Za-z])i\.e\.,?/g, "that is,"],
  [/(?<![A-Za-z])etc\.(?! *$)/g, "et cetera"],
  [/(?<![A-Za-z])etc\./g, "et cetera."],
  [/(?<![A-Za-z])[Aa]pprox\./g, "approximately"],
  [/(?<![A-Za-z])vs\.?(?![A-Za-z])/g, "versus"],
  [/డా\.(?= )/g, "డాక్టర్"],
];
const UNITS_AFTER_NUMBER = /([0-9]) ?(kWh|kW|km|hrs|hr|mins|min|sq\. ?ft|sq ?ft)(?![A-Za-z])/g;
const UNIT_WORDS: Record<string, string> = { kWh: "kilowatt hour", kW: "kilowatt", km: "kilometre", hrs: "hours", hr: "hour", mins: "minutes", min: "minutes" };
/** A bracketed STD code before the rest of a phone number: "(040) 2345 6789". */
const AREA_CODE = /\(([0-9]{2,5})\) ?(?=[0-9])/g;

const AMPM = String.raw`(?: ?([AaPp])\.?[Mm]\.?(?![A-Za-z]))`;
const TIME_SRC = String.raw`([0-9]{1,2})(?:([:.])([0-9]{2}))?` + AMPM + "?";
const TIME = new RegExp(String.raw`(?<![0-9:.,])` + TIME_SRC + String.raw`(?![0-9])`, "g");
const TIME_EXACT = new RegExp(String.raw`^(?<![0-9:.,])` + TIME_SRC + String.raw`(?![0-9])$`);
const TIME_NC = String.raw`[0-9]{1,2}(?:[:.][0-9]{2})?(?: ?[AaPp]\.?[Mm]\.?(?![A-Za-z]))?`;
const TIME_RANGE = new RegExp(String.raw`(?<![0-9:.,])(` + TIME_NC + String.raw`) ?(?:-|–|to) ?(` + TIME_NC + String.raw`)(?![0-9])`, "g");
// An abbreviation's dot is part of the date only before the day ("Mar. 24"), never a sentence end.
const MONTH = String.raw`(January|February|March|April|May|June|July|August|September|October|November|December|` +
  String.raw`(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)(?:\.(?= ?[0-9]))?)`;
const DATE_NUMERIC = /(?<![0-9])([0-9]{1,2})[/.-]([0-9]{1,2})[/.-]([0-9]{4}|[0-9]{2})(?![0-9])/g;
const DATE_ISO = /(?<![0-9])([0-9]{4})[/.-]([0-9]{1,2})[/.-]([0-9]{1,2})(?![0-9])/g;
const DATE_MONTH_FIRST = new RegExp(MONTH + String.raw` ([0-9]{1,2})(?:st|nd|rd|th)?(?:,? ([0-9]{4}))?(?![0-9A-Za-z])`, "g");
const DATE_DAY_FIRST = new RegExp(String.raw`(?<![0-9])([0-9]{1,2})(?:st|nd|rd|th)? (?:of )?` + MONTH + String.raw`(?:,? ([0-9]{4}))?(?![0-9A-Za-z])`, "g");
const AMOUNT = String.raw`([0-9]{1,3}(?:,[0-9]{2,3})+|[0-9]+)(?:\.([0-9]{1,2}))?`;
const SCALE_WORDS = String.raw`(lakhs|lakh|lacs|lac|L|crores|crore|Cr|లక్షలు|లక్షల|లక్ష|కోట్లు|కోట్ల|కోటి)(?![A-Za-z])`;
const SCALE = String.raw`(?: ?` + SCALE_WORDS + ")?";
const RUPEE_WORD = String.raw`(rupees|rupee|రూపాయలు|రూపాయల|రూపాయి)`;
const RUPEE_SIGN = String.raw`(?:₹|Rs\.?|INR|రూ\.) ?`;
const CURRENCY_PREFIX = new RegExp(RUPEE_SIGN + AMOUNT + String.raw`(?: ?/-)?` + SCALE + String.raw`(?: ?` + RUPEE_WORD + String.raw`(?![A-Za-z]))?`, "g");
const CURRENCY_SUFFIX = new RegExp(String.raw`(?<![0-9.,])` + AMOUNT + SCALE + String.raw`(?:(?: ?/-)? ?` + RUPEE_WORD + String.raw`(?![A-Za-z])| ?(/-))`, "g");
/** "₹500 - ₹1,000", "₹2-3 lakh": the currency is said once, after the second amount. */
const PRICE_RANGE = new RegExp(RUPEE_SIGN + AMOUNT + SCALE + String.raw` ?(?:-|–|to) ?(?:` + RUPEE_SIGN + ")?" + AMOUNT + String.raw`(?: ?/-)?` + SCALE +
  String.raw`(?: ?` + RUPEE_WORD + String.raw`(?![A-Za-z]))?`, "g");
const DOLLARS = new RegExp(String.raw`\$ ?` + AMOUNT + String.raw`(?![0-9])`, "g");
/**
 * A booking or reference code: capitals and digits, both present, hyphen-separated
 * groups ("AR-2041", "7Q2X9", "2BHK"). "10AM" and five-letter words ("COVID-19") are not codes.
 */
const CODE = /(?<![A-Za-z0-9:.,/-])[A-Z0-9]+(?:-[A-Z0-9]+)*(?![A-Za-z0-9])/g;
const PERCENT = /(?<![0-9.,])([0-9]+)(?:\.([0-9]+))? ?%/g;
const DIGIT_RUN = /(?<![0-9])(?<![0-9][,.])(\+?)([0-9]+(?:[ -][0-9]+)*)(?!\.?[0-9]|,[0-9])/g;
const ORDINAL = /(?<![0-9.,])([0-9]{1,3})(st|nd|rd|th)(?![A-Za-z])/g;
const NUMBER_RANGE = /(?<![0-9.,])([0-9]{1,3}) ?[-–] ?([0-9]{1,3})(?![0-9.,])/g;
const DECIMAL = /(?<![0-9.,])([0-9]+)\.([0-9]+)(?![0-9])/g;
const INTEGER = /(?<![0-9.,])([0-9]{1,3}(?:,[0-9]{2,3})+|[0-9]+)(?![0-9])/g;
const ACRONYM = /(?<![A-Za-z])([A-Z]{2,3})(?![A-Za-z])/g;
const STRAY_RUPEES = /(?<![A-Za-z])(?:Rs\.?|INR)(?![A-Za-z])|₹/g;
const TE_RUN = /[ఀ-౿]+/y;
const SPACED_TE_WORD = /[ ]+([ఀ-౿]+)/y;
const WORD_BEFORE = /([ఀ-౿]+) *$/;

const SENTENCE_BREAK = /(?<=[.?!।॥])\s+/;
const CLAUSE_BREAK = /(?<=[,;:—–])\s+/;
const SCRIPT_PIECES = /[ఀ-౿]+|[A-Za-z]+|[^A-Za-zఀ-౿]+/g;
const TELUGU = /^[ఀ-౿]/, LATIN = /^[A-Za-z]/;

/* ------------------------------------------------------------------------ */
/* Number words                                                             */
/* ------------------------------------------------------------------------ */

export function cardinal(n: number, language: string): string {
  return language === "te" ? cardinalTe(n) : cardinalEn(n);
}

/** A count before a scale word: a final ఒకటి is ఒక ("ఇరవై ఒక వేలు"). */
function multiplierTe(n: number): string {
  const words = cardinalTe(n);
  return words.endsWith("ఒకటి") ? words.slice(0, -"ఒకటి".length) + "ఒక" : words;
}

function cardinalTe(n: number): string {
  if (n < 20) return UNITS_TE[n];
  if (n < 100) return TENS_TE[Math.floor(n / 10)] + (n % 10 === 0 ? "" : " " + UNITS_TE[n % 10]);
  if (n < 1000) {
    const hundreds = Math.floor(n / 100), rest = n % 100;
    if (hundreds === 1) return rest === 0 ? "వంద" : "నూట " + cardinalTe(rest);
    return UNITS_TE[hundreds] + (rest === 0 ? " వందలు" : " వందల " + cardinalTe(rest));
  }
  for (const [size, single, plural, oblique] of [[10_000_000, "ఒక కోటి", " కోట్లు", " కోట్ల"], [100_000, "ఒక లక్ష", " లక్షలు", " లక్షల"],
    [1000, "వెయ్యి", " వేలు", " వేల"]] as const) {
    if (n >= size) {
      const count = Math.floor(n / size), rest = n % size;
      if (count === 1) return rest === 0 ? single : single + " " + cardinalTe(rest);
      return multiplierTe(count) + (rest === 0 ? plural : oblique + " " + cardinalTe(rest));
    }
  }
  throw new Error("unreachable");
}

function cardinalEn(n: number): string {
  if (n < 20) return UNITS_EN[n];
  if (n < 100) return TENS_EN[Math.floor(n / 10)] + (n % 10 === 0 ? "" : " " + UNITS_EN[n % 10]);
  if (n < 1000) {
    const rest = n % 100;
    return UNITS_EN[Math.floor(n / 100)] + " hundred" + (rest === 0 ? "" : " " + cardinalEn(rest));
  }
  for (const [size, word] of [[10_000_000, "crore"], [100_000, "lakh"], [1000, "thousand"]] as const) {
    if (n >= size) {
      const rest = n % size;
      return cardinalEn(Math.floor(n / size)) + " " + word + (rest === 0 ? "" : " " + cardinalEn(rest));
    }
  }
  throw new Error("unreachable");
}

const endsWithVowelSign = (words: string) => words.endsWith("ు") || words.endsWith("ి");

/** Telugu "-ో" form used with తేదీ (ఇరవై నాలుగో); English "twenty fourth". */
export function ordinal(n: number, language: string): string {
  const words = cardinal(n, language);
  if (language === "te") {
    if (words.endsWith("ై")) return words.slice(0, -1) + "య్యో";
    if (endsWithVowelSign(words)) return words.slice(0, -1) + "ో";
    return words + "వ";
  }
  const cut = words.lastIndexOf(" "), head = cut < 0 ? "" : words.slice(0, cut), last = words.slice(cut + 1);
  const special: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
  const changed = special[last] ?? (last.endsWith("y") ? last.slice(0, -1) + "ieth" : last + "th");
  return head ? `${head} ${changed}` : changed;
}

/** The "-వ" ordinal ("3వ" → మూడవ). */
function ordinalVaTe(n: number): string {
  const words = cardinalTe(n);
  if (words.endsWith("ై")) return words.slice(0, -1) + "య్యవ";
  if (endsWithVowelSign(words)) return words.slice(0, -1) + "వ";
  return words + "వ";
}

function attributiveTe(words: string): string {
  if (words.endsWith("ఒకటి")) return words.slice(0, -"ఒకటి".length) + "ఒక";
  for (const [plural, oblique] of [["వేలు", "వేల"], ["వందలు", "వందల"], ["లక్షలు", "లక్షల"], ["కోట్లు", "కోట్ల"]]) {
    if (words.endsWith(plural)) return words.slice(0, -plural.length) + oblique;
  }
  return words;
}

const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
/** Days in `month`; 29 for February when no year is given. */
function daysInMonth(month: number, year: number | null): number {
  if (month === 2) return year === null || isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function digitWords(digits: string, language: string): string {
  const table = language === "te" ? UNITS_TE : UNITS_EN;
  return Array.from(digits, digit => table[Number(digit)]).join(" ");
}

function decimalWords(whole: string, fraction: string, language: string): string {
  return cardinal(Number(whole.replace(/,/g, "")), language) + (language === "te" ? " పాయింట్ " : " point ") + digitWords(fraction, language);
}

/* ------------------------------------------------------------------------ */
/* Context: which language a number is said in, and the Telugu word after it */
/* ------------------------------------------------------------------------ */

function scriptOf(ch: string | undefined): "te" | "en" | null {
  if (!ch) return null;
  if (ch >= "ఀ" && ch <= "౿") return "te";
  if (/^[A-Za-z]$/.test(ch)) return "en";
  return null;
}

function contextLanguage(text: string, start: number, end: number, base: string | null, available: readonly string[]): string | null {
  const before = text.slice(0, start).replace(/ +$/, ""), after = text.slice(end).replace(/^ +/, "");
  const previous = scriptOf(before.at(-1)), following = scriptOf(after[0]);
  let language: string | null;
  if (following === "te" || (previous === "te" && following !== "en")) language = "te";
  else if (following === "en" || previous === "en") language = "en";
  else language = base;
  if (language !== null && available.includes(language)) return language;
  return base !== null && available.includes(base) ? base : null;
}

function wordBefore(text: string, start: number): string {
  return WORD_BEFORE.exec(text.slice(0, start))?.[1] ?? "";
}

function stickyMatch(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

/** Joins a rendered Telugu number to the word that follows it. */
function attachTe(text: string, end: number, rendered: string, number: number | null = null, nouns = false): [string, number] {
  const attached = stickyMatch(TE_RUN, text, end);
  let suffix: string | null = null, newEnd = end;
  if (attached) {
    suffix = attached[0];
    newEnd = end + attached[0].length;
  } else {
    const spaced = stickyMatch(SPACED_TE_WORD, text, end);
    if (spaced && MERGE_SUFFIXES_TE.has(spaced[1])) {
      suffix = spaced[1];
      newEnd = end + spaced[0].length;
    } else if (spaced && POSTPOSITIONS_TE.has(spaced[1])) {
      return [rendered.endsWith("లు") ? rendered.slice(0, -2) + "ల" : rendered, end];
    } else if (spaced && nouns && NOUNS_TE.has(spaced[1])) {
      return [attributiveTe(rendered), end];
    }
  }
  if (suffix === null) return [rendered, end];
  if (suffix === "వ" && number !== null) return [ordinalVaTe(number), newEnd];
  if (rendered.endsWith("లు")) return [rendered.slice(0, -2) + (suffix === "కి" || suffix === "కు" ? "లకు" : "ల" + suffix), newEnd];
  return [rendered + suffix, newEnd];
}

/* ------------------------------------------------------------------------ */
/* Renderers                                                                */
/* ------------------------------------------------------------------------ */

type Ampm = "am" | "pm" | null;
type TimeParts = [hour: number, minute: number, ampm: Ampm];
type Render = (text: string, match: RegExpExecArray, base: string | null, available: readonly string[]) => [string, number] | null;

function timeParts(match: RegExpExecArray): TimeParts | null {
  const [, hour, separator, minute, ampm] = match;
  if (separator === undefined && ampm === undefined) return null;
  if (separator === "." && ampm === undefined) return null;
  const h = Number(hour), m = Number(minute ?? 0);
  if (m > 59 || h > 23 || (ampm !== undefined && !(h >= 1 && h <= 12))) return null;
  return [h, m, ampm === undefined ? null : (ampm.toLowerCase() + "m") as Ampm];
}

function to24(h: number, ampm: Ampm): number {
  if (ampm === "am") return h === 12 ? 0 : h;
  if (ampm === "pm") return h === 12 ? 12 : h + 12;
  return h;
}

function periodTe(h24: number): string {
  if (h24 < 4 || h24 >= 20) return "రాత్రి";
  if (h24 < 6) return "తెల్లవారుజామున";
  if (h24 < 12) return "ఉదయం";
  if (h24 < 16) return "మధ్యాహ్నం";
  return "సాయంత్రం";
}

const minutesTe = (m: number) => (m === 1 ? "ఒక నిమిషం" : cardinal(m, "te") + " నిమిషాలు");

function timeTe(h: number, m: number, ampm: Ampm, withPeriod: boolean): string {
  const known = ampm !== null || h > 12 || h === 0, h24 = to24(h, ampm), h12 = h24 % 12 || 12;
  const core = h12 === 1 ? (m === 0 ? "ఒంటి గంట" : "ఒంటి గంట " + minutesTe(m))
    : cardinal(h12, "te") + (m === 0 ? " గంటలు" : " గంటల " + minutesTe(m));
  return known && withPeriod ? periodTe(h24) + " " + core : core;
}

function timeEn(h: number, m: number, ampm: Ampm, withSuffix = true): string {
  if (ampm === null && (h > 12 || h === 0)) {
    ampm = h >= 12 ? "pm" : "am";
    h = h > 12 ? h - 12 : 12;
  }
  let words = m === 0 ? cardinal(h, "en") + (ampm ? "" : " o'clock") : cardinal(h, "en") + (m < 10 ? " oh " : " ") + cardinal(m, "en");
  if (ampm && withSuffix) words += ampm === "am" ? " ay em" : " pee em";
  return words;
}

const renderTimeRange: Render = (text, match, base, available) => {
  const first = TIME_EXACT.exec(match[1]), second = TIME_EXACT.exec(match[2]);
  let a = first ? timeParts(first) : null;
  const b = second ? timeParts(second) : null;
  if (b === null || b[2] === null) return null;
  if (a === null) {
    const h1 = /^[0-9]+$/.test(match[1]) ? Number(match[1]) : null;
    if (h1 === null || h1 < 1 || h1 > 12) return null;
    const same = h1 === 12 || (h1 < b[0] && b[0] !== 12);
    a = [h1, 0, same ? b[2] : b[2] === "pm" ? "am" : "pm"];
  }
  const end = match.index + match[0].length;
  const language = contextLanguage(text, match.index, end, base, available);
  if (language === null) return null;
  if (language === "en") return [timeEn(...a, a[2] !== b[2]) + " to " + timeEn(...b), end];
  const withPeriod = !PERIOD_WORDS_TE.has(wordBefore(text, match.index));
  let left = timeTe(...a, withPeriod);
  if (left.endsWith("లు")) left = left.slice(0, -2) + "ల";
  const samePeriod = periodTe(to24(a[0], a[2])) === periodTe(to24(b[0], b[2]));
  const [rendered, newEnd] = attachTe(text, end, timeTe(...b, !samePeriod));
  return [left + " నుంచి " + rendered, newEnd];
};

const renderTime: Render = (text, match, base, available) => {
  const parts = timeParts(match);
  if (parts === null) return null;
  const end = match.index + match[0].length;
  const language = contextLanguage(text, match.index, end, base, available);
  if (language === null) return null;
  if (language === "en") return [timeEn(...parts), end];
  return attachTe(text, end, timeTe(...parts, !PERIOD_WORDS_TE.has(wordBefore(text, match.index))));
};

function dateWords(day: number, month: number, year: number | null, language: string, monthFirst: boolean): string | null {
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(month, year))) return null;
  if (language === "te") return (year ? cardinal(year, "te") + " " : "") + MONTHS_TE[month - 1] + " " + ordinal(day, "te") + " తేదీ";
  const words = monthFirst ? MONTHS_EN[month - 1] + " " + ordinal(day, "en") : ordinal(day, "en") + " " + MONTHS_EN[month - 1];
  return words + (year ? KEEP + " " + cardinal(year, "en") : "");
}

const monthNumber = (name: string) => MONTHS_EN.findIndex(month => month.startsWith(name.slice(0, 3))) + 1;

/**
 * A numeric date is day-first (Indian usage) unless only month-first is a valid
 * reading ("03/24/2026"). One that is no date either way ("31/02/2026") is read
 * out digit by digit rather than guessed.
 */
function renderDate(kind: "numeric" | "iso" | "month_first" | "day_first"): Render {
  return (text, match, base, available) => {
    let day: number, month: number, year: number | null, monthFirst = false;
    if (kind === "numeric") {
      const [first, second] = [Number(match[1]), Number(match[2])];
      year = Number(match[3]);
      if (year < 100) year += 2000;
      monthFirst = first <= 12 && second > 12;
      [day, month] = monthFirst ? [second, first] : [first, second];
    } else if (kind === "iso") {
      [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    } else if (kind === "month_first") {
      [month, day, year] = [monthNumber(match[1]), Number(match[2]), match[3] ? Number(match[3]) : null];
      monthFirst = true;
    } else {
      [day, month, year] = [Number(match[1]), monthNumber(match[2]), match[3] ? Number(match[3]) : null];
    }
    const end = match.index + match[0].length;
    const language = contextLanguage(text, match.index, end, base, available);
    if (language === null) return null;
    const words = dateWords(day, month, year, language, monthFirst);
    if (words === null) {
      if (kind !== "numeric" && kind !== "iso") return null;
      return [[match[1], match[2], match[3]].map(part => digitWords(part, language)).join(KEEP + " "), end];
    }
    return language === "te" ? attachTe(text, end, words) : [words, end];
  };
}

const isLakh = (scale: string) => /^(?:lakh|lac|L$|లక్ష)/.test(scale);

/** An amount before a scale word: "two point five lakh", "రెండు పాయింట్ ఐదు లక్షల". */
function scaledWords(amount: string, paise: string | undefined, scale: string, language: string): string {
  const number = paise ? decimalWords(amount, paise, language) : cardinal(Number(amount.replace(/,/g, "")), language);
  if (language === "te") return `${number} ${isLakh(scale) ? "లక్షల" : "కోట్ల"}`;
  return `${number} ${isLakh(scale) ? "lakh" : "crore"}`;
}

/** An amount of rupees and paise; `noun` keeps the caller's own Telugu rupee word. */
function rupeeWords(amount: string, paise: string | undefined, language: string, noun?: string): string {
  const whole = Number(amount.replace(/,/g, ""));
  const cents = paise && Number(paise) ? Number(paise.padEnd(2, "0")) : 0;
  if (language === "te") {
    const word = noun ?? (whole === 1 ? "రూపాయి" : "రూపాయలు");
    return attributiveTe(cardinal(whole, "te")) + " " + word + (cents ? " " + cardinal(cents, "te") + " పైసలు" : "");
  }
  return cardinal(whole, "en") + (whole === 1 ? " rupee" : " rupees") + (cents ? " and " + cardinal(cents, "en") + " paise" : "");
}

const renderCurrency: Render = (text, match, base, available) => {
  const [, amount, paise, scale, rupee] = match;
  const end = match.index + match[0].length;
  const language = contextLanguage(text, match.index, end, base, available);
  if (language === null) return null;
  if (scale) {
    const number = scaledWords(amount, paise, scale, language);
    return language === "te" ? attachTe(text, end, `${number} రూపాయలు`) : [`${number} rupees`, end];
  }
  if (language === "te") return attachTe(text, end, rupeeWords(amount, paise, "te", rupee && scriptOf(rupee[0]) === "te" ? rupee : undefined));
  return [rupeeWords(amount, paise, "en"), end];
};

const renderPriceRange: Render = (text, match, base, available) => {
  const [, amountA, paiseA, scaleA, amountB, paiseB, scaleB] = match;
  const end = match.index + match[0].length;
  const language = contextLanguage(text, match.index, end, base, available);
  if (language === null) return null;
  if (!scaleA && !scaleB && (paiseA || paiseB)) {
    // With paise, each amount is said in full: "one rupee and fifty paise to two rupees".
    if (language === "en") return [rupeeWords(amountA, paiseA, "en") + " to " + rupeeWords(amountB, paiseB, "en"), end];
    const left = rupeeWords(amountA, paiseA, "te");
    return attachTe(text, end, (left.endsWith("లు") ? left.slice(0, -2) + "ల" : left) + " నుంచి " + rupeeWords(amountB, paiseB, "te"));
  }
  const side = (amount: string, paise: string | undefined, scale: string | undefined) => {
    if (scale) return scaledWords(amount, paise, scale, language);
    if (paise) return decimalWords(amount, paise, language);
    const words = cardinal(Number(amount.replace(/,/g, "")), language);
    return language === "te" ? attributiveTe(words) : words;
  };
  // "₹2-3 lakh" is said "two to three lakh": a scale word only after the second amount covers both.
  const left = side(amountA, paiseA, scaleA), right = side(amountB, paiseB, scaleB);
  if (language === "te") return attachTe(text, end, `${left} నుంచి ${right} రూపాయలు`);
  return [`${left} to ${right} rupees`, end];
};

const renderDollars: Render = (text, match, base, available) => {
  const [, amount, cents] = match;
  const end = match.index + match[0].length;
  const language = contextLanguage(text, match.index, end, base, available);
  if (language === null) return null;
  const whole = Number(amount.replace(/,/g, "")), centValue = cents ? Number(cents.padEnd(2, "0")) : 0;
  if (language === "te") {
    const words = attributiveTe(cardinal(whole, "te")) + (whole === 1 ? " డాలర్" : " డాలర్లు");
    return attachTe(text, end, words + (centValue ? " " + cardinal(centValue, "te") + " సెంట్లు" : ""));
  }
  return [cardinal(whole, "en") + (whole === 1 ? " dollar" : " dollars") + (centValue ? " and " + cardinal(centValue, "en") + (centValue === 1 ? " cent" : " cents") : ""), end];
};

const renderPercent: Render = (text, match, base, available) => {
  const end = match.index + match[0].length;
  const language = contextLanguage(text, match.index, end, base, available);
  if (language === null) return null;
  const number = match[2] ? decimalWords(match[1], match[2], language) : cardinal(Number(match[1]), language);
  return language === "te" ? attachTe(text, end, number + " శాతం") : [number + " percent", end];
};

const renderDigitRun: Render = (text, match, base, available) => {
  const [, plus, body] = match;
  const digits = body.replace(/[ -]/g, "");
  if (digits.length < 5 || digits.length > 15) return null;
  const end = match.index + match[0].length;
  const language = contextLanguage(text, match.index, end, base, available);
  if (language === null) return null;
  let groups = body.split(/[ -]/);
  if (groups.length === 1 && plus && digits.length === 12 && digits.startsWith("91")) groups = ["91", digits.slice(2)];
  else if (groups.length === 1 && digits.length === 11 && digits.startsWith("0")) groups = ["0", digits.slice(1)];
  // As written, except that an Indian mobile number is said 5 + 5 and other long groups in fours.
  groups = groups.flatMap(group => {
    if (group.length === 10) return [group.slice(0, 5), group.slice(5)];
    if (group.length <= 6) return [group];
    return Array.from({ length: Math.ceil(group.length / 4) }, (_, i) => group.slice(i * 4, i * 4 + 4));
  });
  const words = groups.map(group => digitWords(group, language)).join(KEEP + " ");
  return [(plus ? (language === "te" ? "ప్లస్ " : "plus ") : "") + words, end];
};

const renderCode: Render = (text, match) => {
  const code = match[0], groups = code.split("-");
  if (!/[A-Z]/.test(code) || !/[0-9]/.test(code) || /[A-Z]{5}/.test(code)) return null;
  if (groups.some(group => /^[0-9]{1,2}[AP]M$/.test(group))) return null;
  // Always English, so the whole code is one voice and reads as written.
  const spell = (group: string) => Array.from(group, ch => (ch >= "0" && ch <= "9" ? UNITS_EN[Number(ch)] : LETTERS_EN[ch])).join(" ");
  return [groups.map(spell).join(KEEP + " "), match.index + code.length];
};

const renderOrdinal: Render = (text, match, base, available) => {
  const end = match.index + match[0].length;
  const language = contextLanguage(text, match.index, end, base, available);
  if (language === null) return null;
  const words = ordinal(Number(match[1]), language);
  return language === "te" ? attachTe(text, end, words) : [words, end];
};

const renderNumberRange: Render = (text, match, base, available) => {
  const end = match.index + match[0].length;
  const language = contextLanguage(text, match.index, end, base, available);
  if (language === null) return null;
  const a = Number(match[1]), b = Number(match[2]);
  if (language === "te") {
    const [rendered, newEnd] = attachTe(text, end, cardinal(b, "te"), null, true);
    return [cardinal(a, "te") + " నుంచి " + rendered, newEnd];
  }
  return [cardinal(a, "en") + " to " + cardinal(b, "en"), end];
};

const renderDecimal: Render = (text, match, base, available) => {
  const end = match.index + match[0].length;
  const language = contextLanguage(text, match.index, end, base, available);
  if (language === null) return null;
  const words = decimalWords(match[1], match[2], language);
  return language === "te" ? attachTe(text, end, words) : [words, end];
};

const renderInteger: Render = (text, match, base, available) => {
  const end = match.index + match[0].length;
  const language = contextLanguage(text, match.index, end, base, available);
  if (language === null) return null;
  const raw = match[1], digits = raw.replace(/,/g, "");
  if (raw.startsWith("0") && raw.length > 1) return [digitWords(digits, language), end];
  const number = Number(digits);
  if (number >= 10 ** 9) return [digitWords(digits, language), end];
  return language === "te" ? attachTe(text, end, cardinal(number, "te"), number, true) : [cardinal(number, "en"), end];
};

const NUMERIC_PASSES: [RegExp, Render][] = [
  [CODE, renderCode],
  [DATE_ISO, renderDate("iso")],
  [DATE_NUMERIC, renderDate("numeric")],
  [DATE_MONTH_FIRST, renderDate("month_first")],
  [DATE_DAY_FIRST, renderDate("day_first")],
  [TIME_RANGE, renderTimeRange],
  [TIME, renderTime],
  [PRICE_RANGE, renderPriceRange],
  [CURRENCY_PREFIX, renderCurrency],
  [CURRENCY_SUFFIX, renderCurrency],
  [DOLLARS, renderDollars],
  [PERCENT, renderPercent],
  [DIGIT_RUN, renderDigitRun],
  [ORDINAL, renderOrdinal],
  [NUMBER_RANGE, renderNumberRange],
  [DECIMAL, renderDecimal],
  [INTEGER, renderInteger],
];

function substitute(text: string, pattern: RegExp, render: Render, base: string | null, available: readonly string[]): string {
  const out: string[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index < last) continue;
    const result = render(text, match as RegExpExecArray, base, available);
    if (result === null) continue;
    out.push(text.slice(last, match.index), result[0]);
    last = result[1];
  }
  out.push(text.slice(last));
  return out.join("");
}

function normalize(text: string, base: string | null, available: readonly string[]): string {
  text = text.normalize("NFC");
  text = Array.from(text, ch => (ch >= "౦" && ch <= "౯" ? String.fromCharCode(ch.charCodeAt(0) - 0x0c66 + 0x30) : ch)).join("");
  text = text.replace(/[*_#`•]+/g, "").replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of ABBREVIATIONS) text = text.replace(pattern, replacement);
  text = text.replace(UNITS_AFTER_NUMBER, (_, digit: string, unit: string) => `${digit} ${UNIT_WORDS[unit] ?? "square feet"}`);
  text = text.replace(AREA_CODE, "$1 ");
  for (const [pattern, render] of NUMERIC_PASSES) text = substitute(text, pattern, render, base, available);
  text = text.replace(STRAY_RUPEES, "rupees");
  text = text.replace(ACRONYM, (_, letters: string) => (letters === "OK" ? "okay" : Array.from(letters, letter => LETTERS_EN[letter]).join(" ")));
  return text.replace(/ +/g, " ").replace(/ (?=[,.?!;:])/g, "").trim();
}

/** The words the local voices should say for `text` (see the module comment). */
export function normalizeForSpeech(text: string, base: string | null, available: readonly string[]): string {
  return normalize(text, base, available).replaceAll(KEEP, ",");
}

/* ------------------------------------------------------------------------ */
/* Segmentation                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Splits a line into (language, text) runs by script: Telugu letters select
 * the Telugu voice and Latin letters the English one, because the Telugu
 * voice mispronounces English words written in Latin letters. Digits and
 * punctuation stay with the run they are in; `base` (the language HALO named
 * for the line) speaks anything script-neutral.
 */
export function splitScriptRuns(text: string, base: string | null, available: readonly string[]): { language: string; text: string }[] {
  const runs: { language: string | null; text: string }[] = [];
  for (const piece of text.match(SCRIPT_PIECES) ?? []) {
    const script = TELUGU.test(piece) ? "te" : LATIN.test(piece) ? "en" : null;
    const last = runs[runs.length - 1];
    if (last && (script === null || last.language === null || last.language === script)) { last.language ??= script; last.text += piece; }
    else runs.push({ language: script, text: piece });
  }
  return runs.filter(run => run.text.trim()).map(run => {
    const language = run.language ?? base;
    if (!language || !available.includes(language)) throw new UnspeakableTextError("no local voice can speak this text");
    return { language, text: run.text.trim() };
  });
}

/**
 * Breaks a long sentence at clause punctuation. The voice model synthesizes a
 * whole piece before any of it can be played, so a long sentence delays the
 * first audio by its full synthesis time. Short pieces are merged forward,
 * and a short last piece back, so short lines stay whole and keep their
 * prosody. A protected comma is never a break.
 */
export function splitClauses(text: string, splitAbove = CLAUSE_SPLIT_CHARS, minimum = CLAUSE_MIN_CHARS): string[] {
  if (text.length <= splitAbove) return [text];
  const pieces: string[] = [];
  for (const part of text.split(CLAUSE_BREAK)) {
    if (pieces.length && pieces[pieces.length - 1].length < minimum) pieces[pieces.length - 1] += ` ${part}`;
    else if (part.trim()) pieces.push(part);
  }
  if (pieces.length > 1 && pieces[pieces.length - 1].length < minimum) {
    const tail = pieces.pop()!;
    pieces[pieces.length - 1] += ` ${tail}`;
  }
  return pieces;
}

/** The pause a segment ends with: sentence, clause, or a mid-phrase voice switch. */
export function pauseKind(text: string): PauseKind {
  const last = text.trimEnd().slice(-1);
  if (last && ".?!।॥".includes(last)) return "sentence";
  if (last && ",;:—–".includes(last)) return "clause";
  return "switch";
}

/** Segments for one HALO line, in order. Throws UnspeakableTextError when a run has no voice. */
export function planSpeech(text: string, base: string | null, available: readonly string[]): SpeechSegment[] {
  const segments: SpeechSegment[] = [];
  for (const sentence of normalize(text, base, available).split(SENTENCE_BREAK)) {
    if (!sentence.trim()) continue;
    for (const clause of splitClauses(sentence)) {
      for (const run of splitScriptRuns(clause, base, available)) {
        const spoken = run.text.replaceAll(KEEP, ",");
        segments.push({ language: run.language, text: spoken, pause: pauseKind(spoken) });
      }
    }
  }
  const last = segments[segments.length - 1];
  if (last?.pause === "switch") last.pause = "clause";
  return segments;
}

/* ------------------------------------------------------------------------ */
/* Audio joining                                                            */
/* ------------------------------------------------------------------------ */

/** Cuts a segment's own leading/trailing silence (keeping `keepMs`) and fades its edges. */
export function trimAndFade(samples: Float32Array, rate: number, options: { trimThreshold?: number; keepMs?: number; fadeMs?: number } = {}): Float32Array {
  const { trimThreshold, keepMs, fadeMs } = { ...SHAPE_DEFAULTS, ...options };
  let first = -1, last = -1;
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) > trimThreshold) { first = i; break; }
  if (first < 0) return samples;
  for (let i = samples.length - 1; i >= 0; i--) if (Math.abs(samples[i]) > trimThreshold) { last = i; break; }
  const keep = Math.round((rate * keepMs) / 1000);
  const out = samples.slice(Math.max(0, first - keep), Math.min(samples.length, last + 1 + keep));
  const fade = Math.min(Math.round((rate * fadeMs) / 1000), Math.floor(out.length / 2));
  for (let i = 0; i < fade; i++) {
    out[i] *= i / fade;
    out[out.length - 1 - i] *= i / fade;
  }
  return out;
}

export function pauseSamples(kind: PauseKind, rate: number, pauses: Readonly<Record<PauseKind, number>> = PAUSE_MS): Float32Array {
  return new Float32Array(Math.round((rate * pauses[kind]) / 1000));
}
