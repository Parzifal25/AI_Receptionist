"""Text and audio shaping for the local (Piper) TTS — HALO Phase B.

The Piper voices read raw text through espeak-ng, which says a phone number
as one huge cardinal, treats "Dr." and "Rs." as sentence ends, and reads
"10:30 AM" in whatever language the voice happens to be. Sarvam is called
with its own preprocessing disabled, so nothing upstream fixes this either.
This module turns a HALO line into what the local voices should say:

1. `normalize_for_speech` writes numbers, dates, times, prices, units and
   common abbreviations out as words, in the language of the words around
   them (a number next to Telugu is said in Telugu, next to English in
   English, otherwise in the line's language). Booking codes (`AR-2041`)
   are spelled character by character in English.
2. `plan_speech` cuts the line into synthesis segments: one per sentence,
   long sentences at clause punctuation (never inside a phone number or a
   date), then by script, because the Telugu voice garbles Latin words.
   Each segment carries the pause that should follow it.
3. `trim_and_fade` / `pause_samples` join the segments: each segment's own
   leading and trailing silence is trimmed, its edges faded, and an explicit
   pause inserted, so a voice switch mid-phrase is not a quarter-second gap.

The TypeScript twin is packages/providers/voice-vendors/local-tts-text.ts.
Both must produce the same output for tests/fixtures/local-tts-text-cases.json.
Telugu renderings are engineering choices, not reviewed by a native speaker;
see docs/LOCAL_SPEECH_BENCHMARK.md (Phase B.5) for what still needs a listener.
"""

from __future__ import annotations

import math
import re
import unicodedata
from typing import Callable, Optional

import numpy as np

# Pause after a segment, by how the segment ends (see plan_speech).
PAUSE_MS = {"sentence": 280, "clause": 160, "switch": 40}
# Trim threshold (linear amplitude), silence kept at each trimmed edge, fade length.
SHAPE_DEFAULTS = {"trim_threshold": 0.01, "keep_ms": 25, "fade_ms": 5}
# Speed used when HALO names no speaking rate, per voice language.
DEFAULT_SPEED: dict[str, float] = {}
CLAUSE_SPLIT_CHARS = 60
CLAUSE_MIN_CHARS = 25

# A comma that must not become a segment boundary (inside a phone number or a date).
KEEP = ""

_TE = "ఀ-౿"
_TE_RUN = re.compile(f"[{_TE}]+")
_SPACED_TE_WORD = re.compile(f"[ ]+([{_TE}]+)")

UNITS_TE = ["సున్నా", "ఒకటి", "రెండు", "మూడు", "నాలుగు", "ఐదు", "ఆరు", "ఏడు", "ఎనిమిది", "తొమ్మిది", "పది",
            "పదకొండు", "పన్నెండు", "పదమూడు", "పద్నాలుగు", "పదిహేను", "పదహారు", "పదిహేడు", "పద్దెనిమిది", "పంతొమ్మిది"]
TENS_TE = ["", "", "ఇరవై", "ముప్పై", "నలభై", "యాభై", "అరవై", "డెబ్బై", "ఎనభై", "తొంభై"]
UNITS_EN = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
            "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
TENS_EN = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
MONTHS_TE = ["జనవరి", "ఫిబ్రవరి", "మార్చి", "ఏప్రిల్", "మే", "జూన్", "జూలై", "ఆగస్టు", "సెప్టెంబర్", "అక్టోబర్", "నవంబర్", "డిసెంబర్"]
LETTERS_EN = {"A": "ay", "B": "bee", "C": "see", "D": "dee", "E": "ee", "F": "ef", "G": "jee", "H": "aitch", "I": "eye", "J": "jay",
              "K": "kay", "L": "el", "M": "em", "N": "en", "O": "oh", "P": "pee", "Q": "cue", "R": "ar", "S": "es", "T": "tee",
              "U": "you", "V": "vee", "W": "double you", "X": "ex", "Y": "why", "Z": "zed"}
# Said before a time when it carries no AM/PM word of its own.
PERIOD_WORDS_TE = {"ఉదయం", "మధ్యాహ్నం", "సాయంత్రం", "రాత్రి", "తెల్లవారుజామున"}
# Telugu words that join the number before them ("గంటలు" + "కి" → "గంటలకు").
MERGE_SUFFIXES_TE = {"కి", "కు", "లో", "న"}
# Postpositions that take the oblique form ("గంటలు" → "గంటల తర్వాత").
POSTPOSITIONS_TE = {"వరకు", "నుంచి", "నుండి", "తర్వాత", "ముందు", "లోపు", "కోసం", "దాకా"}
# Nouns a number qualifies: the number takes its attributive form ("ఒక గంట", "రెండు వేల మంది").
NOUNS_TE = {"రూపాయలు", "రూపాయల", "రూపాయి", "మంది", "రోజు", "రోజులు", "రోజుల", "గంట", "గంటలు", "గంటల", "నిమిషం",
            "నిమిషాలు", "నిమిషాల", "సంవత్సరం", "సంవత్సరాలు", "సంవత్సరాల", "నెల", "నెలలు", "నెలల", "వారం", "వారాలు",
            "యూనిట్లు", "యూనిట్ల", "ప్యానెల్స్"}

ABBREVIATIONS = [
    (re.compile(r"(?<![A-Za-z])Dr\.(?= )"), "Doctor"),
    (re.compile(r"(?<![A-Za-z])Mrs\.(?= )"), "Missus"),
    (re.compile(r"(?<![A-Za-z])Mr\.(?= )"), "Mister"),
    (re.compile(r"(?<![A-Za-z])Ms\.(?= )"), "Miz"),
    (re.compile(r"(?<![A-Za-z])Sr\. ?No\."), "serial number"),
    (re.compile(r"(?<![A-Za-z])No\.(?= ?(?:[0-9]|[A-Z]{1,4}-?[0-9]))"), "number"),
    (re.compile(r"(?<![A-Za-z])Ref\.(?= )"), "reference"),
    (re.compile(r"(?<![A-Za-z])Opp\.(?= )"), "opposite"),
    (re.compile(r"(?<![A-Za-z])Appt\.(?= )"), "appointment"),
    (re.compile(r"(?<![A-Za-z])Mob(?:\.(?= )|(?=:))"), "mobile"),
    (re.compile(r"(?<![A-Za-z])Ph(?:\.(?= )|(?=:))"), "phone"),
    # "Rd." after a name; its dot stays a sentence end unless lower case, a digit or a comma follows.
    (re.compile(r"(?<=[A-Za-z] )Rd\.(?= [a-z0-9]|,)"), "Road"),
    (re.compile(r"(?<=[A-Za-z] )Rd\."), "Road."),
    (re.compile(r"(?<=[A-Za-z] )Rd(?![A-Za-z.])"), "Road"),
    (re.compile(r"(?<![A-Za-z])Pvt\. Ltd\."), "Private Limited"),
    (re.compile(r"(?<![A-Za-z])Ltd\."), "Limited"),
    (re.compile(r"(?<![A-Za-z])e\.g\.,?"), "for example,"),
    (re.compile(r"(?<![A-Za-z])i\.e\.,?"), "that is,"),
    (re.compile(r"(?<![A-Za-z])etc\.(?! *$)"), "et cetera"),
    (re.compile(r"(?<![A-Za-z])etc\."), "et cetera."),
    (re.compile(r"(?<![A-Za-z])[Aa]pprox\."), "approximately"),
    (re.compile(r"(?<![A-Za-z])vs\.?(?![A-Za-z])"), "versus"),
    (re.compile(r"డా\.(?= )"), "డాక్టర్"),
]
UNITS_AFTER_NUMBER = re.compile(r"([0-9]) ?(kWh|kW|km|hrs|hr|mins|min|sq\. ?ft|sq ?ft)(?![A-Za-z])")
UNIT_WORDS = {"kWh": "kilowatt hour", "kW": "kilowatt", "km": "kilometre", "hrs": "hours", "hr": "hour", "mins": "minutes", "min": "minutes"}
# A bracketed STD code before the rest of a phone number: "(040) 2345 6789".
AREA_CODE = re.compile(r"\(([0-9]{2,5})\) ?(?=[0-9])")

_AMPM = r"(?: ?([AaPp])\.?[Mm]\.?(?![A-Za-z]))"
_TIME_SRC = r"([0-9]{1,2})(?:([:.])([0-9]{2}))?" + _AMPM + "?"
TIME = re.compile(r"(?<![0-9:.,])" + _TIME_SRC + r"(?![0-9])")
_TIME_NC = r"[0-9]{1,2}(?:[:.][0-9]{2})?(?: ?[AaPp]\.?[Mm]\.?(?![A-Za-z]))?"
TIME_RANGE = re.compile(r"(?<![0-9:.,])(" + _TIME_NC + r") ?(?:-|–|to) ?(" + _TIME_NC + r")(?![0-9])")
# An abbreviation's dot is part of the date only before the day ("Mar. 24"), never a sentence end.
_MONTH = (r"(January|February|March|April|May|June|July|August|September|October|November|December|"
          r"(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)(?:\.(?= ?[0-9]))?)")
DATE_NUMERIC = re.compile(r"(?<![0-9])([0-9]{1,2})[/.-]([0-9]{1,2})[/.-]([0-9]{4}|[0-9]{2})(?![0-9])")
DATE_ISO = re.compile(r"(?<![0-9])([0-9]{4})[/.-]([0-9]{1,2})[/.-]([0-9]{1,2})(?![0-9])")
DATE_MONTH_FIRST = re.compile(_MONTH + r" ([0-9]{1,2})(?:st|nd|rd|th)?(?:,? ([0-9]{4}))?(?![0-9A-Za-z])")
DATE_DAY_FIRST = re.compile(r"(?<![0-9])([0-9]{1,2})(?:st|nd|rd|th)? (?:of )?" + _MONTH + r"(?:,? ([0-9]{4}))?(?![0-9A-Za-z])")
_AMOUNT = r"([0-9]{1,3}(?:,[0-9]{2,3})+|[0-9]+)(?:\.([0-9]{1,2}))?"
_SCALE_WORDS = r"(lakhs|lakh|lacs|lac|L|crores|crore|Cr|లక్షలు|లక్షల|లక్ష|కోట్లు|కోట్ల|కోటి)(?![A-Za-z])"
_SCALE = r"(?: ?" + _SCALE_WORDS + ")?"
_RUPEE_WORD = r"(rupees|rupee|రూపాయలు|రూపాయల|రూపాయి)"
_RUPEE_SIGN = r"(?:₹|Rs\.?|INR|రూ\.) ?"
CURRENCY_PREFIX = re.compile(_RUPEE_SIGN + _AMOUNT + r"(?: ?/-)?" + _SCALE + r"(?: ?" + _RUPEE_WORD + r"(?![A-Za-z]))?")
CURRENCY_SUFFIX = re.compile(r"(?<![0-9.,])" + _AMOUNT + _SCALE + r"(?:(?: ?/-)? ?" + _RUPEE_WORD + r"(?![A-Za-z])| ?(/-))")
# "₹500 - ₹1,000", "₹2-3 lakh": the currency is said once, after the second amount.
PRICE_RANGE = re.compile(_RUPEE_SIGN + _AMOUNT + _SCALE + r" ?(?:-|–|to) ?(?:" + _RUPEE_SIGN + ")?" + _AMOUNT + r"(?: ?/-)?" + _SCALE
                         + r"(?: ?" + _RUPEE_WORD + r"(?![A-Za-z]))?")
DOLLARS = re.compile(r"\$ ?" + _AMOUNT + r"(?![0-9])")
# A booking or reference code: capitals and digits, both present, hyphen-separated
# groups ("AR-2041", "7Q2X9", "2BHK"). "10AM" and five-letter words ("COVID-19") are not codes.
CODE = re.compile(r"(?<![A-Za-z0-9:.,/-])[A-Z0-9]+(?:-[A-Z0-9]+)*(?![A-Za-z0-9])")
PERCENT = re.compile(r"(?<![0-9.,])([0-9]+)(?:\.([0-9]+))? ?%")
DIGIT_RUN = re.compile(r"(?<![0-9])(?<![0-9][,.])(\+?)([0-9]+(?:[ -][0-9]+)*)(?!\.?[0-9]|,[0-9])")
ORDINAL = re.compile(r"(?<![0-9.,])([0-9]{1,3})(st|nd|rd|th)(?![A-Za-z])")
NUMBER_RANGE = re.compile(r"(?<![0-9.,])([0-9]{1,3}) ?[-–] ?([0-9]{1,3})(?![0-9.,])")
DECIMAL = re.compile(r"(?<![0-9.,])([0-9]+)\.([0-9]+)(?![0-9])")
INTEGER = re.compile(r"(?<![0-9.,])([0-9]{1,3}(?:,[0-9]{2,3})+|[0-9]+)(?![0-9])")
ACRONYM = re.compile(r"(?<![A-Za-z])([A-Z]{2,3})(?![A-Za-z])")
STRAY_RUPEES = re.compile(r"(?<![A-Za-z])(?:Rs\.?|INR)(?![A-Za-z])|₹")

_SENTENCE_BREAK = re.compile(r"(?<=[.?!।॥])\s+")
_CLAUSE_BREAK = re.compile(r"(?<=[,;:—–])\s+")
_SCRIPT_PIECES = re.compile(r"[ఀ-౿]+|[A-Za-z]+|[^A-Za-zఀ-౿]+")
_TELUGU = re.compile(r"[ఀ-౿]")
_LATIN = re.compile(r"[A-Za-z]")


class UnspeakableText(ValueError):
    """No installed voice can speak a run of the text."""


# ---------------------------------------------------------------------------
# Number words
# ---------------------------------------------------------------------------


def cardinal(n: int, language: str) -> str:
    return _cardinal_te(n) if language == "te" else _cardinal_en(n)


def _multiplier_te(n: int) -> str:
    """A count before a scale word: a final ఒకటి is ఒక ("ఇరవై ఒక వేలు")."""
    words = _cardinal_te(n)
    return words[: -len("ఒకటి")] + "ఒక" if words.endswith("ఒకటి") else words


def _cardinal_te(n: int) -> str:
    if n < 20:
        return UNITS_TE[n]
    if n < 100:
        return TENS_TE[n // 10] + ("" if n % 10 == 0 else " " + UNITS_TE[n % 10])
    if n < 1000:
        hundreds, rest = divmod(n, 100)
        if hundreds == 1:
            return "వంద" if rest == 0 else "నూట " + _cardinal_te(rest)
        return UNITS_TE[hundreds] + (" వందలు" if rest == 0 else " వందల " + _cardinal_te(rest))
    for size, single, plural, oblique in ((10_000_000, "ఒక కోటి", " కోట్లు", " కోట్ల"), (100_000, "ఒక లక్ష", " లక్షలు", " లక్షల"),
                                          (1000, "వెయ్యి", " వేలు", " వేల")):
        if n >= size:
            count, rest = divmod(n, size)
            if count == 1:
                return single if rest == 0 else single + " " + _cardinal_te(rest)
            return _multiplier_te(count) + (plural if rest == 0 else oblique + " " + _cardinal_te(rest))
    raise AssertionError("unreachable")


def _cardinal_en(n: int) -> str:
    if n < 20:
        return UNITS_EN[n]
    if n < 100:
        return TENS_EN[n // 10] + ("" if n % 10 == 0 else " " + UNITS_EN[n % 10])
    if n < 1000:
        hundreds, rest = divmod(n, 100)
        return UNITS_EN[hundreds] + " hundred" + ("" if rest == 0 else " " + _cardinal_en(rest))
    for size, word in ((10_000_000, "crore"), (100_000, "lakh"), (1000, "thousand")):
        if n >= size:
            count, rest = divmod(n, size)
            return _cardinal_en(count) + " " + word + ("" if rest == 0 else " " + _cardinal_en(rest))
    raise AssertionError("unreachable")


def ordinal(n: int, language: str) -> str:
    """Telugu "-ో" form used with తేదీ (ఇరవై నాలుగో); English "twenty fourth"."""
    words = cardinal(n, language)
    if language == "te":
        if words.endswith("ై"):
            return words[:-1] + "య్యో"
        if words.endswith(("ు", "ి")):
            return words[:-1] + "ో"
        return words + "వ"
    head, _, last = words.rpartition(" ")
    special = {"one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth", "nine": "ninth", "twelve": "twelfth"}
    last = special.get(last) or (last[:-1] + "ieth" if last.endswith("y") else last + "th")
    return f"{head} {last}" if head else last


def _ordinal_va_te(n: int) -> str:
    """The "-వ" ordinal ("3వ" → మూడవ)."""
    words = _cardinal_te(n)
    if words.endswith("ై"):
        return words[:-1] + "య్యవ"
    if words.endswith(("ు", "ి")):
        return words[:-1] + "వ"
    return words + "వ"


def _attributive_te(words: str) -> str:
    if words.endswith("ఒకటి"):
        return words[: -len("ఒకటి")] + "ఒక"
    for plural, oblique in (("వేలు", "వేల"), ("వందలు", "వందల"), ("లక్షలు", "లక్షల"), ("కోట్లు", "కోట్ల")):
        if words.endswith(plural):
            return words[: -len(plural)] + oblique
    return words


def _is_leap_year(year: int) -> bool:
    return (year % 4 == 0 and year % 100 != 0) or year % 400 == 0


def _days_in_month(month: int, year: Optional[int]) -> int:
    """Days in `month`; 29 for February when no year is given."""
    if month == 2:
        return 29 if year is None or _is_leap_year(year) else 28
    return 30 if month in (4, 6, 9, 11) else 31


def _digits(digits: str, language: str) -> str:
    table = UNITS_TE if language == "te" else UNITS_EN
    return " ".join(table[int(d)] for d in digits)


def _decimal(whole: str, fraction: str, language: str) -> str:
    point = " పాయింట్ " if language == "te" else " point "
    return cardinal(int(whole.replace(",", "")), language) + point + _digits(fraction, language)


# ---------------------------------------------------------------------------
# Context: which language a number is said in, and the Telugu word after it
# ---------------------------------------------------------------------------


def _script(ch: str) -> Optional[str]:
    if "ఀ" <= ch <= "౿":
        return "te"
    if ch.isascii() and ch.isalpha():
        return "en"
    return None


def _context_language(text: str, start: int, end: int, base: Optional[str], available: list[str]) -> Optional[str]:
    before = text[:start].rstrip(" ")
    after = text[end:].lstrip(" ")
    previous = _script(before[-1]) if before else None
    following = _script(after[0]) if after else None
    if following == "te" or (previous == "te" and following != "en"):
        language = "te"
    elif following == "en" or previous == "en":
        language = "en"
    else:
        language = base
    if language in available:
        return language
    return base if base in available else None


def _word_before(text: str, start: int) -> str:
    match = re.search(f"([{_TE}]+) *$", text[:start])
    return match.group(1) if match else ""


def _attach_te(text: str, end: int, rendered: str, number: Optional[int] = None, nouns: bool = False) -> tuple[str, int]:
    """Joins a rendered Telugu number to the word that follows it."""
    attached = _TE_RUN.match(text, end)
    suffix, new_end = None, end
    if attached:
        suffix, new_end = attached.group(0), attached.end()
    else:
        spaced = _SPACED_TE_WORD.match(text, end)
        if spaced and spaced.group(1) in MERGE_SUFFIXES_TE:
            suffix, new_end = spaced.group(1), spaced.end()
        elif spaced and spaced.group(1) in POSTPOSITIONS_TE:
            return (rendered[:-2] + "ల" if rendered.endswith("లు") else rendered), end
        elif spaced and nouns and spaced.group(1) in NOUNS_TE:
            return _attributive_te(rendered), end
    if suffix is None:
        return rendered, end
    if suffix == "వ" and number is not None:
        return _ordinal_va_te(number), new_end
    if rendered.endswith("లు"):
        return rendered[:-2] + ("లకు" if suffix in ("కి", "కు") else "ల" + suffix), new_end
    return rendered + suffix, new_end


# ---------------------------------------------------------------------------
# Renderers
# ---------------------------------------------------------------------------


def _time_parts(match: re.Match) -> Optional[tuple[int, int, Optional[str]]]:
    hour, separator, minute, ampm = match.group(1), match.group(2), match.group(3), match.group(4)
    if separator is None and ampm is None:
        return None
    if separator == "." and ampm is None:
        return None
    h, m = int(hour), int(minute or 0)
    if m > 59 or h > 23 or (ampm and not 1 <= h <= 12):
        return None
    return h, m, (ampm.lower() + "m") if ampm else None


def _to_24(h: int, ampm: Optional[str]) -> int:
    if ampm == "am":
        return 0 if h == 12 else h
    if ampm == "pm":
        return 12 if h == 12 else h + 12
    return h


def _period_te(h24: int) -> str:
    if h24 < 4 or h24 >= 20:
        return "రాత్రి"
    if h24 < 6:
        return "తెల్లవారుజామున"
    if h24 < 12:
        return "ఉదయం"
    if h24 < 16:
        return "మధ్యాహ్నం"
    return "సాయంత్రం"


def _time_te(h: int, m: int, ampm: Optional[str], with_period: bool) -> str:
    known = ampm is not None or h > 12 or h == 0
    h24 = _to_24(h, ampm)
    h12 = h24 % 12 or 12
    if h12 == 1:
        core = "ఒంటి గంట" if m == 0 else "ఒంటి గంట " + _minutes_te(m)
    else:
        core = cardinal(h12, "te") + (" గంటలు" if m == 0 else " గంటల " + _minutes_te(m))
    return (_period_te(h24) + " " + core) if known and with_period else core


def _minutes_te(m: int) -> str:
    return "ఒక నిమిషం" if m == 1 else cardinal(m, "te") + " నిమిషాలు"


def _time_en(h: int, m: int, ampm: Optional[str], with_suffix: bool = True) -> str:
    if ampm is None and (h > 12 or h == 0):
        ampm = "pm" if h >= 12 else "am"
        h = h - 12 if h > 12 else 12
    if m == 0:
        words = cardinal(h, "en") + ("" if ampm else " o'clock")
    else:
        words = cardinal(h, "en") + (" oh " if m < 10 else " ") + cardinal(m, "en")
    if ampm and with_suffix:
        words += " ay em" if ampm == "am" else " pee em"
    return words


def _render_time_range(text: str, match: re.Match, base, available):
    first, second = TIME.fullmatch(match.group(1)), TIME.fullmatch(match.group(2))
    a = _time_parts(first) if first else None
    b = _time_parts(second) if second else None
    if b is None or b[2] is None:
        return None
    if a is None:
        h1 = int(match.group(1)) if match.group(1).isdigit() else None
        if h1 is None or not 1 <= h1 <= 12:
            return None
        same = h1 == 12 or (h1 < b[0] and b[0] != 12)
        a = (h1, 0, b[2] if same else ("am" if b[2] == "pm" else "pm"))
    language = _context_language(text, match.start(), match.end(), base, available)
    if language is None:
        return None
    if language == "en":
        if a[2] == b[2]:
            return _time_en(*a, with_suffix=False) + " to " + _time_en(*b), match.end()
        return _time_en(*a) + " to " + _time_en(*b), match.end()
    with_period = _word_before(text, match.start()) not in PERIOD_WORDS_TE
    left = _time_te(*a, with_period=with_period)
    left = left[:-2] + "ల" if left.endswith("లు") else left
    same_period = _period_te(_to_24(a[0], a[2])) == _period_te(_to_24(b[0], b[2]))
    right = _time_te(*b, with_period=not same_period)
    rendered, end = _attach_te(text, match.end(), right)
    return left + " నుంచి " + rendered, end


def _render_time(text: str, match: re.Match, base, available):
    parts = _time_parts(match)
    if parts is None:
        return None
    language = _context_language(text, match.start(), match.end(), base, available)
    if language is None:
        return None
    if language == "en":
        return _time_en(*parts), match.end()
    with_period = _word_before(text, match.start()) not in PERIOD_WORDS_TE
    return _attach_te(text, match.end(), _time_te(*parts, with_period=with_period))


def _date_words(day: int, month: int, year: Optional[int], language: str, month_first: bool) -> Optional[str]:
    if not (1 <= month <= 12 and 1 <= day <= _days_in_month(month, year)):
        return None
    if language == "te":
        head = cardinal(year, "te") + " " if year else ""
        return head + MONTHS_TE[month - 1] + " " + ordinal(day, "te") + " తేదీ"
    words = (MONTHS_EN[month - 1] + " " + ordinal(day, "en")) if month_first else (ordinal(day, "en") + " " + MONTHS_EN[month - 1])
    return words + (KEEP + " " + cardinal(year, "en") if year else "")


def _month_number(name: str) -> int:
    return next(i for i, month in enumerate(MONTHS_EN, start=1) if month.startswith(name[:3]))


def _render_date(kind: str):
    """A numeric date is day-first (Indian usage) unless only month-first is a valid
    reading ("03/24/2026"). One that is no date either way ("31/02/2026") is read
    out digit by digit rather than guessed."""
    def render(text: str, match: re.Match, base, available):
        if kind == "numeric":
            first, second, year = int(match.group(1)), int(match.group(2)), int(match.group(3))
            year = year + 2000 if year < 100 else year
            month_first = first <= 12 and second > 12
            day, month = (second, first) if month_first else (first, second)
        elif kind == "iso":
            year, month, day = int(match.group(1)), int(match.group(2)), int(match.group(3))
            month_first = False
        elif kind == "month_first":
            month, day = _month_number(match.group(1)), int(match.group(2))
            year = int(match.group(3)) if match.group(3) else None
            month_first = True
        else:
            day, month = int(match.group(1)), _month_number(match.group(2))
            year = int(match.group(3)) if match.group(3) else None
            month_first = False
        language = _context_language(text, match.start(), match.end(), base, available)
        if language is None:
            return None
        words = _date_words(day, month, year, language, month_first)
        if words is None:
            if kind not in ("numeric", "iso"):
                return None
            return (KEEP + " ").join(_digits(part, language) for part in match.group(1, 2, 3)), match.end()
        return _attach_te(text, match.end(), words) if language == "te" else (words, match.end())
    return render


def _is_lakh(scale: str) -> bool:
    return bool(re.match(r"(?:lakh|lac|L$|లక్ష)", scale))


def _scaled(amount: str, paise: Optional[str], scale: str, language: str) -> str:
    """An amount before a scale word: "two point five lakh", "రెండు పాయింట్ ఐదు లక్షల"."""
    number = _decimal(amount, paise, language) if paise else cardinal(int(amount.replace(",", "")), language)
    if language == "te":
        return f"{number} {'లక్షల' if _is_lakh(scale) else 'కోట్ల'}"
    return f"{number} {'lakh' if _is_lakh(scale) else 'crore'}"


def _rupees(amount: str, paise: Optional[str], language: str, noun: Optional[str] = None) -> str:
    """An amount of rupees and paise; `noun` keeps the caller's own Telugu rupee word."""
    whole = int(amount.replace(",", ""))
    cents = int(paise.ljust(2, "0")) if paise and int(paise) else 0
    if language == "te":
        word = noun or ("రూపాయి" if whole == 1 else "రూపాయలు")
        return _attributive_te(cardinal(whole, "te")) + " " + word + (" " + cardinal(cents, "te") + " పైసలు" if cents else "")
    return cardinal(whole, "en") + (" rupee" if whole == 1 else " rupees") + (" and " + cardinal(cents, "en") + " paise" if cents else "")


def _render_currency(text: str, match: re.Match, base, available):
    amount, paise, scale, rupee = match.group(1), match.group(2), match.group(3), match.group(4)
    language = _context_language(text, match.start(), match.end(), base, available)
    if language is None:
        return None
    if scale:
        number = _scaled(amount, paise, scale, language)
        if language == "te":
            return _attach_te(text, match.end(), f"{number} రూపాయలు")
        return f"{number} rupees", match.end()
    if language == "te":
        return _attach_te(text, match.end(), _rupees(amount, paise, "te", rupee if rupee and _script(rupee[0]) == "te" else None))
    return _rupees(amount, paise, "en"), match.end()


def _render_price_range(text: str, match: re.Match, base, available):
    amount_a, paise_a, scale_a, amount_b, paise_b, scale_b = match.group(1, 2, 3, 4, 5, 6)
    language = _context_language(text, match.start(), match.end(), base, available)
    if language is None:
        return None
    if not scale_a and not scale_b and (paise_a or paise_b):
        # With paise, each amount is said in full: "one rupee and fifty paise to two rupees".
        if language == "en":
            return _rupees(amount_a, paise_a, "en") + " to " + _rupees(amount_b, paise_b, "en"), match.end()
        left = _rupees(amount_a, paise_a, "te")
        left = left[:-2] + "ల" if left.endswith("లు") else left
        return _attach_te(text, match.end(), left + " నుంచి " + _rupees(amount_b, paise_b, "te"))

    def side(amount: str, paise: Optional[str], scale: Optional[str]) -> str:
        if scale:
            return _scaled(amount, paise, scale, language)
        if paise:
            return _decimal(amount, paise, language)
        words = cardinal(int(amount.replace(",", "")), language)
        return _attributive_te(words) if language == "te" else words

    # "₹2-3 lakh" is said "two to three lakh": a scale word only after the second amount covers both.
    left, right = side(amount_a, paise_a, scale_a), side(amount_b, paise_b, scale_b)
    if language == "te":
        return _attach_te(text, match.end(), f"{left} నుంచి {right} రూపాయలు")
    return f"{left} to {right} rupees", match.end()


def _render_dollars(text: str, match: re.Match, base, available):
    amount, cents = match.group(1), match.group(2)
    language = _context_language(text, match.start(), match.end(), base, available)
    if language is None:
        return None
    whole = int(amount.replace(",", ""))
    cent_value = int(cents.ljust(2, "0")) if cents else 0
    if language == "te":
        words = _attributive_te(cardinal(whole, "te")) + (" డాలర్" if whole == 1 else " డాలర్లు")
        if cent_value:
            words += " " + cardinal(cent_value, "te") + " సెంట్లు"
        return _attach_te(text, match.end(), words)
    words = cardinal(whole, "en") + (" dollar" if whole == 1 else " dollars")
    if cent_value:
        words += " and " + cardinal(cent_value, "en") + (" cent" if cent_value == 1 else " cents")
    return words, match.end()


def _render_percent(text: str, match: re.Match, base, available):
    language = _context_language(text, match.start(), match.end(), base, available)
    if language is None:
        return None
    number = _decimal(match.group(1), match.group(2), language) if match.group(2) else cardinal(int(match.group(1)), language)
    if language == "te":
        return _attach_te(text, match.end(), number + " శాతం")
    return number + " percent", match.end()


def _render_digit_run(text: str, match: re.Match, base, available):
    plus, body = match.group(1), match.group(2)
    digits = re.sub(r"[ -]", "", body)
    if len(digits) < 5 or len(digits) > 15:
        return None
    language = _context_language(text, match.start(), match.end(), base, available)
    if language is None:
        return None
    groups = re.split(r"[ -]", body)
    if len(groups) == 1 and plus and len(digits) == 12 and digits.startswith("91"):
        groups = ["91", digits[2:]]
    elif len(groups) == 1 and len(digits) == 11 and digits.startswith("0"):
        groups = ["0", digits[1:]]
    # As written, except that an Indian mobile number is said 5 + 5 and other long groups in fours.
    split: list[str] = []
    for group in groups:
        if len(group) == 10:
            split += [group[:5], group[5:]]
        elif len(group) <= 6:
            split.append(group)
        else:
            split += [group[i:i + 4] for i in range(0, len(group), 4)]
    groups = split
    words = (KEEP + " ").join(_digits(group, language) for group in groups)
    if plus:
        words = ("ప్లస్ " if language == "te" else "plus ") + words
    return words, match.end()


def _render_code(text: str, match: re.Match, base, available):
    code = match.group(0)
    groups = code.split("-")
    if not re.search(r"[A-Z]", code) or not re.search(r"[0-9]", code) or re.search(r"[A-Z]{5}", code):
        return None
    if any(re.fullmatch(r"[0-9]{1,2}[AP]M", group) for group in groups):
        return None
    # Always English, so the whole code is one voice and reads as written.
    spelled = (" ".join(UNITS_EN[int(ch)] if ch.isdigit() else LETTERS_EN[ch] for ch in group) for group in groups)
    return (KEEP + " ").join(spelled), match.end()


def _render_ordinal(text: str, match: re.Match, base, available):
    language = _context_language(text, match.start(), match.end(), base, available)
    if language is None:
        return None
    words = ordinal(int(match.group(1)), language)
    return _attach_te(text, match.end(), words) if language == "te" else (words, match.end())


def _render_number_range(text: str, match: re.Match, base, available):
    language = _context_language(text, match.start(), match.end(), base, available)
    if language is None:
        return None
    a, b = int(match.group(1)), int(match.group(2))
    if language == "te":
        rendered, end = _attach_te(text, match.end(), cardinal(b, "te"), nouns=True)
        return cardinal(a, "te") + " నుంచి " + rendered, end
    return cardinal(a, "en") + " to " + cardinal(b, "en"), match.end()


def _render_decimal(text: str, match: re.Match, base, available):
    language = _context_language(text, match.start(), match.end(), base, available)
    if language is None:
        return None
    words = _decimal(match.group(1), match.group(2), language)
    return _attach_te(text, match.end(), words) if language == "te" else (words, match.end())


def _render_integer(text: str, match: re.Match, base, available):
    language = _context_language(text, match.start(), match.end(), base, available)
    if language is None:
        return None
    raw = match.group(1)
    digits = raw.replace(",", "")
    if raw.startswith("0") and len(raw) > 1:
        return _digits(digits, language), match.end()
    number = int(digits)
    if number >= 10 ** 9:
        return _digits(digits, language), match.end()
    if language == "te":
        return _attach_te(text, match.end(), cardinal(number, "te"), number=number, nouns=True)
    return cardinal(number, "en"), match.end()


Renderer = Callable[[str, re.Match, Optional[str], list[str]], Optional[tuple[str, int]]]
NUMERIC_PASSES: list[tuple[re.Pattern, Renderer]] = [
    (CODE, _render_code),
    (DATE_ISO, _render_date("iso")),
    (DATE_NUMERIC, _render_date("numeric")),
    (DATE_MONTH_FIRST, _render_date("month_first")),
    (DATE_DAY_FIRST, _render_date("day_first")),
    (TIME_RANGE, _render_time_range),
    (TIME, _render_time),
    (PRICE_RANGE, _render_price_range),
    (CURRENCY_PREFIX, _render_currency),
    (CURRENCY_SUFFIX, _render_currency),
    (DOLLARS, _render_dollars),
    (PERCENT, _render_percent),
    (DIGIT_RUN, _render_digit_run),
    (ORDINAL, _render_ordinal),
    (NUMBER_RANGE, _render_number_range),
    (DECIMAL, _render_decimal),
    (INTEGER, _render_integer),
]


def _substitute(text: str, pattern: re.Pattern, render, base, available) -> str:
    out, last = [], 0
    for match in pattern.finditer(text):
        if match.start() < last:
            continue
        result = render(text, match, base, available)
        if result is None:
            continue
        replacement, end = result
        out.append(text[last:match.start()])
        out.append(replacement)
        last = end
    out.append(text[last:])
    return "".join(out)


def _spell(match: re.Match) -> str:
    letters = match.group(1)
    return "okay" if letters == "OK" else " ".join(LETTERS_EN[letter] for letter in letters)


def _normalize(text: str, base: Optional[str], available: list[str]) -> str:
    text = unicodedata.normalize("NFC", text)
    text = "".join(chr(ord(ch) - 0x0C66 + 0x30) if "౦" <= ch <= "౯" else ch for ch in text)
    text = re.sub(r"[*_#`•]+", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    for pattern, replacement in ABBREVIATIONS:
        text = pattern.sub(replacement, text)
    text = UNITS_AFTER_NUMBER.sub(lambda m: m.group(1) + " " + UNIT_WORDS.get(m.group(2), "square feet"), text)
    text = AREA_CODE.sub(r"\1 ", text)
    for pattern, render in NUMERIC_PASSES:
        text = _substitute(text, pattern, render, base, available)
    text = STRAY_RUPEES.sub("rupees", text)
    text = ACRONYM.sub(_spell, text)
    text = re.sub(r" +", " ", text)
    return re.sub(r" (?=[,.?!;:])", "", text).strip()


def normalize_for_speech(text: str, base: Optional[str], available: list[str]) -> str:
    """The words the local voices should say for `text` (see the module docstring)."""
    return _normalize(text, base, available).replace(KEEP, ",")


# ---------------------------------------------------------------------------
# Segmentation
# ---------------------------------------------------------------------------


def split_script_runs(text: str, base: Optional[str], available: list[str]) -> list[tuple[str, str]]:
    """Split a line into (language, text) runs by script.

    Telugu letters select the Telugu voice and Latin letters the English one;
    digits and punctuation stay with the run they are in. `base` (the
    language HALO named for the line) speaks anything script-neutral. Raises
    when a run has no voice: speaking Telugu script through an English voice
    produces letter names, not speech.
    """
    runs: list[tuple[Optional[str], str]] = []
    for token in _SCRIPT_PIECES.findall(text):
        script = "te" if _TELUGU.match(token) else "en" if _LATIN.match(token) else None
        if runs and (script is None or runs[-1][0] is None or runs[-1][0] == script):
            previous_language, previous_text = runs[-1]
            runs[-1] = (previous_language or script, previous_text + token)
        else:
            runs.append((script, token))
    resolved: list[tuple[str, str]] = []
    for language, run in runs:
        if not run.strip():
            continue
        language = language or base
        if language is None or language not in available:
            raise UnspeakableText("no local voice can speak this text")
        resolved.append((language, run.strip()))
    return resolved


def split_clauses(text: str, split_above: int = CLAUSE_SPLIT_CHARS, minimum: int = CLAUSE_MIN_CHARS) -> list[str]:
    """Break a long sentence at clause punctuation.

    The voice model synthesizes a whole piece before any of it can be played,
    so a long sentence delays the first audio by its full synthesis time.
    Short pieces are merged forward, and a short last piece back, so short
    lines stay whole and keep their prosody. A protected comma (KEEP) is
    never a break.
    """
    if len(text) <= split_above:
        return [text]
    pieces: list[str] = []
    for part in _CLAUSE_BREAK.split(text):
        if pieces and len(pieces[-1]) < minimum:
            pieces[-1] = f"{pieces[-1]} {part}"
        elif part.strip():
            pieces.append(part)
    if len(pieces) > 1 and len(pieces[-1]) < minimum:
        tail = pieces.pop()
        pieces[-1] = f"{pieces[-1]} {tail}"
    return pieces


def pause_kind(text: str) -> str:
    """The pause a segment ends with: sentence, clause, or a mid-phrase voice switch."""
    last = text.rstrip()[-1:]
    if last and last in ".?!।॥":
        return "sentence"
    if last and last in ",;:—–":
        return "clause"
    return "switch"


def plan_speech(text: str, base: Optional[str], available: list[str]) -> list[tuple[str, str, str]]:
    """(language, text, pause-after) segments for one HALO line, in order."""
    normalized = _normalize(text, base, available)
    segments: list[tuple[str, str, str]] = []
    for sentence in _SENTENCE_BREAK.split(normalized):
        if not sentence.strip():
            continue
        for clause in split_clauses(sentence):
            for language, run in split_script_runs(clause, base, available):
                run = run.replace(KEEP, ",")
                segments.append((language, run, pause_kind(run)))
    if segments and segments[-1][2] == "switch":
        segments[-1] = (segments[-1][0], segments[-1][1], "clause")
    return segments


# ---------------------------------------------------------------------------
# Audio joining
# ---------------------------------------------------------------------------


def _samples_for(rate: int, ms: float) -> int:
    """Rounds half up, as Math.round does in the TypeScript twin (Python's round() rounds half to even)."""
    return int(math.floor(rate * ms / 1000 + 0.5))


def trim_and_fade(samples: np.ndarray, rate: int, trim_threshold: float = 0.01, keep_ms: float = 25, fade_ms: float = 5) -> np.ndarray:
    """Cut a segment's own leading/trailing silence (keeping `keep_ms`) and fade its edges."""
    loud = np.nonzero(np.abs(samples) > trim_threshold)[0]
    if not len(loud):
        return samples
    keep = _samples_for(rate, keep_ms)
    out = np.array(samples[max(0, int(loud[0]) - keep): min(len(samples), int(loud[-1]) + 1 + keep)], dtype=np.float32)
    fade = min(_samples_for(rate, fade_ms), len(out) // 2)
    if fade > 0:
        ramp = np.arange(fade, dtype=np.float32) / fade
        out[:fade] *= ramp
        out[-fade:] *= ramp[::-1]
    return out


def pause_samples(kind: str, rate: int, pauses: Optional[dict[str, float]] = None) -> np.ndarray:
    return np.zeros(_samples_for(rate, (pauses or PAUSE_MS)[kind]), dtype=np.float32)
