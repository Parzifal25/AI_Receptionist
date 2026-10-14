# Local Telugu TTS — wording and pronunciation decisions awaiting a Telugu-fluent reviewer

**Status (2026-10-14): open. No reviewer has seen this list; nothing here is
reviewed Telugu.** Every rendering below was chosen by an engineer and is
pinned by `tests/fixtures/local-tts-text-cases.json`, so both local TTS
implementations (`services/pipecat-worker/local_tts_text.py`,
`packages/providers/voice-vendors/local-tts-text.ts`) say exactly this today.
Applies to the **local** (Piper) voices only. Sarvam, the production primary,
is called with its own preprocessing and is not affected.

How to use: for each row, mark **keep** or write the replacement wording in
the last column. Where you are unsure, write *ask owner*. A changed row means
an engineer edits both implementations and the fixture together; no row
should be changed from this list without a reviewer's entry.

Hear the current renderings in the blinded packet
(`LOCAL_TELUGU_TTS_BLIND_REVIEW.md`) and in
`models/local-speech-benchmark/tts-te-voices/b6-regression/<voice>/` (booking
codes, month-first dates, price ranges, phone formats, abbreviations).

## A. Pronunciation (listening only — text is correct, the voice may not be)

| # | What to listen for | Where | Reviewer decision |
| --- | --- | --- | --- |
| A1 | **మీకు vs నీకు.** In Phase B.2 a Whisper Telugu model heard Venkatesh's `మీకు` as `నీకు` in 6 of 9 clips; the installed recognizer heard it correctly every time. Neither machine result settles it. Saying the informal నీకు to a customer is a politeness error. | Blind packet Part A | |
| A2 | Digits one at a time: are సున్నా, ఒకటి, ఏడు, ఎనిమిది clearly distinct at phone speed? Is the comma pause between digit groups audible and helpful? | Blind packet `d01`; `b6-regression/k10` | |
| A3 | పది vs పదకొండు, ఆరు vs ఏడు in times | `c05`, blind packet times | |
| A4 | Conjuncts and long vowels in names (`శ్రీలక్ష్మి`, `రెడ్డి గారికి`) | `n01` | |
| A5 | English loanwords written in Telugu script (`అపాయింట్‌మెంట్`, `క్యాన్సిల్`, `రీషెడ్యూల్`, `బుకింగ్`) spoken by the Telugu voice | `t01`, `x01`, `b02` | |
| A6 | Pace: Padmavathi produces ~16 % more audio for the same text (slower). Is either voice too fast or too slow for a phone call? | Blind packet Part B | |

## B. Wording chosen by the text pipeline

| # | Input | Current local rendering | Alternatives to consider | Reviewer decision |
| --- | --- | --- | --- | --- |
| B1 | `24/03/2026` (Telugu line) | రెండు వేల ఇరవై ఆరు మార్చి ఇరవై నాలుగో తేదీ (year first) | మార్చి ఇరవై నాలుగో తేదీ, రెండు వేల ఇరవై ఆరు · drop the year when it is the current year (upstream wording) | |
| B2 | Day ordinal | `-ో` form: ఇరవై నాలుగో, ఇరవయ్యో, ముప్పయ్యో, ఒకటో | `-వ` form: ఇరవై నాలుగవ, ఇరవయ్యవ · cardinal + తేదీ: ఇరవై నాలుగు తేదీ | |
| B3 | `మార్చి 24న` | మార్చి ఇరవై నాలుగున | మార్చి ఇరవై నాలుగో తేదీన | |
| B4 | `24/03/2026 న` | …నాలుగో తేదీన | …నాలుగో తేదీ నాడు | |
| B5 | `10:30` | పది గంటల ముప్పై నిమిషాలు | పదిన్నర · పది ముప్పై; likewise :15/:45 as పావు / ముప్పావు | |
| B6 | `10:30 కి` | …ముప్పై నిమిషాలకు | పదిన్నరకు | |
| B7 | `1:00 PM` | మధ్యాహ్నం ఒంటి గంట | ఒక గంట | |
| B8 | Period word by hour (only when the line has none) | 04–06 తెల్లవారుజామున · 06–12 ఉదయం · 12–16 మధ్యాహ్నం · 16–20 సాయంత్రం · 20–04 రాత్రి | different boundaries (e.g. సాయంత్రం from 15:00?); తెల్లవారుజామున vs తెల్లవారి | |
| B9 | `9 AM - 6 PM వరకు` | ఉదయం తొమ్మిది గంటల నుంచి సాయంత్రం ఆరు గంటల వరకు | నుండి instead of నుంచి | |
| B10 | `₹1,45,000` | ఒక లక్ష నలభై ఐదు వేల రూపాయలు | లక్షా నలభై ఐదు వేల రూపాయలు | |
| B11 | `1000`, `100`, `120` | వెయ్యి, వంద, నూట ఇరవై | ఒక వెయ్యి; నూరు | |
| B12 | `₹2-3 lakh` (new) | రెండు నుంచి మూడు లక్షల రూపాయలు | రెండు మూడు లక్షల రూపాయలు | |
| B13 | `₹500-1,000` (new) | ఐదు వందల నుంచి వెయ్యి రూపాయలు | ఐదు వందల రూపాయల నుంచి వెయ్యి రూపాయల వరకు | |
| B14 | `₹1.50-₹2.50` (new) | ఒక రూపాయి యాభై పైసల నుంచి రెండు రూపాయలు యాభై పైసలు | — | |
| B15 | `2.5 లక్షలు`, `₹2.5L` (new) | రెండు పాయింట్ ఐదు లక్షలు | రెండున్నర లక్షలు | |
| B16 | `40%` | నలభై శాతం | నలభై పర్సెంట్ | |
| B17 | `21 రోజులు`, `1 రోజు` | ఇరవై ఒక రోజులు, ఒక రోజు | ఇరవై ఒక్క రోజులు, ఒక్క రోజు | |
| B18 | `$100` (new) | వంద డాలర్లు | — | |
| B19 | Phone number in a Telugu line | Telugu digit words, 5 + 5: తొమ్మిది ఎనిమిది నాలుగు ఎనిమిది సున్నా, ఒకటి… | English digits even in Telugu lines (common in speech); సున్నా vs జీరో; ప్లస్ తొమ్మిది ఒకటి for +91 | |
| B20 | `+919848012345`, `09848012345` (new) | plus nine one, nine eight four eight zero, one two three four five · సున్నా, తొమ్మిది… (leading 0 said separately) | — | |

## C. Code-switching and English inside Telugu lines

| # | Input | Current rendering | Question | Reviewer decision |
| --- | --- | --- | --- | --- |
| C1 | Booking code `AR-2041` in any line (new) | Always the **English** voice, letter by letter and digit by digit: "ay ar, two zero four one" | Should digits follow the line's language (రెండు సున్నా నాలుగు ఒకటి)? Digit by digit vs "twenty forty-one"? | |
| C2 | Letter names | American English voice: ay, ar, aitch, zed, double you | Indian letter names (ae, aar, etch)? There is no Indian-English local voice installed. | |
| C3 | `GST`, `SMS`, `EMI`, `OTP`, `UPI`, `ID` in Telugu lines | Spelled by the English voice: jee es tee | Acceptable, or should these be in Telugu script upstream (జీఎస్‌టీ)? | |
| C4 | `Dr. Ravi Kumar గారు` | English voice says "Doctor Ravi Kumar", Telugu voice says గారు | Names in Latin letters are read by an American voice. Should HALO write Telugu names in Telugu script? | |
| C5 | `appointmentకి`, `AR-2041కి` | English word, then కి synthesized on its own by the Telugu voice | Is the one-syllable switch intelligible? | |
| C6 | Mid-sentence voice switch | Venkatesh (male) + Joe (male, US); Padmavathi (female) + Joe (male, US) — a gender switch mid-sentence | Acceptable on a customer call? (owner decision too) | |
| C7 | `5 PM` next to Telugu | సాయంత్రం ఐదు గంటలు (Telugu) · next to English: "five pee em" | — | |

## D. Ambiguities the pipeline resolves by rule (business owner + reviewer)

| # | Input | Rule today | Decision needed | Decision |
| --- | --- | --- | --- | --- |
| D1 | `03/04/2026` | Day-first (3 April), Indian usage. Month-first only when the second number is over 12 (`03/24/2026` → 24 March). | Confirm day-first. Better: HALO should never emit a numeric date in speech text. | |
| D2 | `31/02/2026` (impossible date) | Read digit by digit ("three one, zero two, two zero two six"); not guessed | — | |
| D3 | `5-2-40` (Hyderabad house number) | Read as a date (5 February 2040) | Addresses should not reach TTS in this form, or need an address rule | |
| D4 | `St.` | Left as is (Saint/Street ambiguous); the dot ends the sentence | — | |
| D5 | Lower-case codes (`ar-2041`) | Not treated as codes ("ar-two thousand forty one") | HALO should emit codes in capitals | |
