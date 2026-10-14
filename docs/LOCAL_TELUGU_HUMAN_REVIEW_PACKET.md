# Telugu speech human review packet

**Status:** prepared for review; no human acceptance has been recorded. This
packet does not replace the missing human-read FLEURS audio. Do not combine
synthetic STT results with human-recorded results.

## What is available

`models/local-speech-benchmark/` is git-ignored local evidence. It contains
nine synthetic Sarvam corpus WAVs (`corpus/te-1.wav` through `te-3.wav`,
`mix-4.wav` through `mix-6.wav`, and `en-7.wav` through `en-9.wav`), saved
TTS sample WAVs, and model result JSON. The result JSON includes the eight
FLEURS Telugu references and candidate hypotheses, but the corresponding
FLEURS WAV files are absent. Thus the prior machine scores in
`LOCAL_SPEECH_BENCHMARK.md` cannot be independently rerun against human Telugu
audio from this checkout. The synthetic corpus may be replayed as a separate
machine regression set; it is not human speech and cannot establish caller
performance.

## TTS listening set (existing generated audio)

Listen on headphones or a phone speaker at a comfortable level. For each
item, first listen without reading the text, then listen while following the
prompt. Record the reviewer’s Telugu fluency (native / fluent / other) and
date. Rate each dimension 1 (poor) to 5 (excellent); use `N/A` where it does
not apply. Do not infer naturalness from an STT transcript.

| ID | WAV (relative to repo root) | Model / voice | Text to be spoken | Specific check |
| --- | --- | --- | --- | --- |
| T1 | `models/local-speech-benchmark/tts-samples/sherpa-piper-te_IN-venkatesh-medium/te.wav` | sherpa-onnx Piper `te_IN-venkatesh-medium` | నమస్కారం, మీకు ఏ సమాచారం కావాలి? | Is `మీకు` clear and respectful? Natural rhythm and pronunciation? |
| T2 | `models/local-speech-benchmark/tts-samples/sherpa-piper-te_IN-maya-medium/te.wav` | sherpa-onnx Piper `te_IN-maya-medium` | నమస్కారం, మీకు ఏ సమాచారం కావాలి? | Same text and ratings as T1; compare voice quality. |
| T3 | `models/local-speech-benchmark/tts-samples/sherpa-piper-te_IN-padmavathi-medium/te.wav` | sherpa-onnx Piper `te_IN-padmavathi-medium` | నమస్కారం, మీకు ఏ సమాచారం కావాలి? | Same text and ratings as T1; compare voice quality. |
| T4 | `models/local-speech-benchmark/tts-samples/sherpa-split/mix.wav` | sherpa split: `te_IN-venkatesh-medium` + `en_US-joe-medium` | మీకు solar panel price గురించి తెలుసుకోవాలా? | Two voices are used mid-sentence. Is the switch jarring? Are English words intelligible? |
| T5 | `models/local-speech-benchmark/tts-samples/sherpa-piper-te_IN-maya-medium/mix-translit.wav` | sherpa-onnx Piper `te_IN-maya-medium` | మీకు సోలార్ ప్యానెల్ ప్రైస్ గురించి తెలుసుకోవాలా? | One Telugu voice; are transliterated loan words intelligible and natural? |
| T6 | `models/local-speech-benchmark/tts-samples/sherpa-piper-en_US-joe-medium/en.wav` | sherpa-onnx Piper `en_US-joe-medium` | Sure, I can help you with the installation details. | Is the American English voice acceptable to Telugu-speaking Indian callers? |

For every row fill: `intelligible __/5; pronunciation __/5; naturalness
__/5; pace __/5; acceptable for a customer call yes/no; words heard (if
different); notes: ____`. Reviewers should score independently before
discussing results. These files cover neutral Telugu, code-mixing, voice
switching, and English; they do not cover TTS reading of names, dates, times,
or digit sequences. Those need a later TTS sample generation pass from the
same approved text below; do not treat an ungenerated prompt as reviewed audio.

## STT human recording set (record these prompts)

Use only speakers who have given informed, recorded consent for speech
collection, transcription, local model evaluation, and review by the named
project reviewers. Store consent separately from audio; assign anonymous
speaker IDs; do not commit recordings or consent forms. Speakers must use a
project-controlled test number, never their real phone number, and that number
must never be dialed. A participant may withdraw their recording; remove it
from the evaluation set and record the exclusion.

Before recording, fill in the named project contact, who can access the files,
and the deletion date, then read this consent summary to each speaker and
record their agreement separately from the WAVs:

> We would like to record you reading Telugu and Telugu-English speech prompts
> to evaluate HALO speech recognition and speech playback. The recordings and
> verified transcripts will be processed locally and reviewed by the named
> project reviewers for this evaluation. They will not be used for a live
> customer call, published, or shared outside this review. Your name and
> contact details will not be stored with the audio. You may skip any prompt,
> stop at any time, or request deletion before [deletion date] by contacting
> [project contact]. Do you consent to this recording and review?

Record an explicit yes/no, date, consent version, anonymous speaker ID, and
the project contact/deletion date in the separate consent log. Do not record
if the speaker declines or those fields have not been filled in.

Use a Telugu-fluent speaker, a phone handset or the actual intended call
microphone, quiet room, one take per line, natural conversational pace. Save
uncompressed mono WAV at the native recording rate, plus a copy downsampled to
8 kHz using a documented resampler. Do not clean up, denoise, or trim speech
inside the utterance. Record the speaker’s exact spoken words as the reference;
preserve whether English words were spoken in Latin-style pronunciation or
Telugu transliteration. Keep speaker identity private in filenames. Use
recording IDs from [`LOCAL_TELUGU_RECORDING_MANIFEST.csv`](LOCAL_TELUGU_RECORDING_MANIFEST.csv).
For example, speaker P01's quiet S01 take is `TE-P01-S01-Q` and its files are
`$HOME/halo-telugu-review/audio/P01/S01-quiet-native.wav` and
`$HOME/halo-telugu-review/audio/P01/S01-quiet-8k.wav`. Noisy paired takes use
the `-N` ID suffix and `-noisy-` filenames. Record at least three
Telugu-fluent speakers (P01–P03), each completing all 18 quiet prompts; also
record the four paired noisy prompts. Use the separate
[`LOCAL_TELUGU_CONSENT_LOG_TEMPLATE.csv`](LOCAL_TELUGU_CONSENT_LOG_TEMPLATE.csv)
and have each reviewer complete a separate
[`LOCAL_TELUGU_REVIEWER_FORM.md`](LOCAL_TELUGU_REVIEWER_FORM.md). A reviewer
must verify each reference transcript against the recording before scoring.

| ID | Say exactly (Telugu / Tenglish) | Reference meaning / critical tokens |
| --- | --- | --- |
| S01 | నమస్కారం, నాకు మా ఇంటికి సోలార్ ప్యానెల్స్ గురించి తెలుసుకోవాలి. | Greeting; home solar inquiry |
| S02 | నా పేరు రవి కుమార్. | Name: Ravi Kumar |
| S03 | నా పేరు శ్రీలక్ష్మి రెడ్డి. | Name: Srilakshmi Reddy |
| S04 | నేను హైదరాబాద్‌లోని కూకట్‌పల్లిలో ఉంటాను. | Place name: Kukatpally, Hyderabad |
| S05 | నాకు వచ్చే సోమవారం అపాయింట్‌మెంట్ కావాలి. | Relative date: next Monday; appointment request |
| S06 | మార్చి ఇరవై నాలుగో తేదీ నాకు వీలవుతుంది. | Date: March 24 |
| S07 | ఉదయం పది గంటలకు రావచ్చు. | Time: 10:00 AM |
| S08 | సాయంత్రం ఆరు గంటల తర్వాత ఫోన్ చేయండి. | Callback time: after 6:00 PM |
| S09 | నా ఫోన్ నంబర్ తొమ్మిది ఎనిమిది ఏడు ఆరు ఐదు నాలుగు మూడు రెండు ఒకటి సున్నా. | Digit sequence: 9876543210 |
| S10 | నా నంబర్ ప్లస్ తొమ్మిది ఒకటి, తొమ్మిది ఎనిమిది ఏడు ఆరు ఐదు నాలుగు మూడు రెండు ఒకటి సున్నా. | Country code +91 plus 9876543210 |
| S11 | రేపు మార్నింగ్ టెన్ ఓ క్లాక్‌కి అపాయింట్‌మెంట్ పెట్టండి. | Tenglish: tomorrow, 10:00 AM; booking request |
| S12 | నా బుకింగ్ క్యాన్సిల్ చేసి నెక్స్ట్ వీక్‌కి రీషెడ్యూల్ చేయండి. | Tenglish: cancel booking and reschedule next week; preserve cancel/reschedule polarity |
| S13 | శనివారం సాయంత్రం ఐదు గంటలకు సైట్ విజిట్ బుక్ చేయండి. | Saturday, 5:00 PM; booking request |
| S14 | పది గంటలు కాదు, పదకొండు గంటలకు రావాలి. | Correction: 11:00, explicitly not 10:00 |
| S15 | ఫోన్ నంబర్ తొమ్మిది ఎనిమిది ఏడు ఆరు ఐదు నాలుగు మూడు రెండు ఒకటి సున్నా కదా? కాదు, చివరి అంకె తొమ్మిది. | Correction: number ends in 9, not 0 |
| S16 | నా పేరు జాన్ విలియమ్స్. | English name spoken with Telugu pronunciation: John Williams |
| S17 | అపాయింట్‌మెంట్. | Short utterance; appointment keyword |
| S18 | నమస్కారం, నా పేరు జాన్ విలియమ్స్. వచ్చే సోమవారం ఉదయం పది గంటలకు మా ఇంటి దగ్గర సైట్ విజిట్ కావాలి. నా ఫోన్ నంబర్ తొమ్మిది సున్నా సున్నా సున్నా సున్నా సున్నా సున్నా సున్నా సున్నా సున్నా. మీరు బుకింగ్ చేసే ముందు తేదీ, సమయం, నంబర్ మళ్లీ చెప్పి నిర్ధారించండి. | Longer connected request; name/date/time/test phone/booking confirmation |

For a noisy condition, repeat S01, S09, S12, and S18 once in a moderately
noisy real environment with participant consent. Capture the real room sound
as it is; do not overlay artificial noise. Mark these takes `noise=moderate`
and keep the quiet takes as the paired comparison. Do not expose bystanders;
choose a controlled location where everyone recorded has consented. This
provides short and long samples, multiple speakers, and paired quiet/noisy
conditions. If fewer than three consented speakers are available, report the
actual count and do not imply the target set was completed.

For each take, save the exact reference transcript and note speaker, device,
room noise (quiet / moderate / noisy), and whether the utterance was repeated.
Run the exact same native and 8 kHz files through the candidate under test;
record model/version, runtime/version, language hint, configuration, and raw
transcript. Do not score by comparing one model’s output with another model’s
output.

For every included clip, create a manifest row with anonymous `speaker_id`,
clip ID, condition, sample rate, duration, verified reference transcript,
SHA-256, and a separate consent-record ID. Keep consent records outside the
audio directory. The checked-in test set should contain only de-identified
audio covered by the participant’s consent.

## Scoring sheet and acceptance notes

Report counts and WER/CER separately for native-rate and 8 kHz Telugu, and
separately for natural Telugu, Tenglish, and booking-critical prompts. State
the normalization rules (Unicode normalization, punctuation, spaces, digit
words versus numerals) and retain both raw and normalized text. For every
critical token, record exact match and whether a human had to correct it:

| Clip | Raw hypothesis | Reference verified? | WER / CER | Telugu script intact? | Name/date/time/phone exact? | Cancel/reschedule intent correct? | Human correction needed? | Failure notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |  |

List representative failures verbatim, especially wrong person/place names,
date rollovers, AM/PM shifts, digit substitutions, and negation or
cancel/reschedule reversals. Do not claim acceptance from aggregate WER/CER
alone. A native speaker must listen to every clip and judge semantic impact;
the business owner must separately decide whether the residual errors are
acceptable for booking. Minimum review bar before describing a speech path as
accepted: at least three consented speakers complete all 18 prompts in quiet
conditions; Telugu and Tenglish are scored separately; each reviewer verifies
the references and listens to every clip; WER is at most 20% and CER at most
10% for Telugu, WER at most 25% and CER at most 12% for Tenglish; at least 98%
of Telugu-script output characters are Telugu; there are zero uncorrected
name, phone digit, date, time, negation, cancellation, or rescheduling errors
in the tested booking-critical clips. Report noisy-condition results
separately; no aggregate may hide a critical error. Until those criteria and
actual reviewer feedback are recorded, status remains **awaiting human
review**.

## Current confirmation behavior to review

The confidence-based fallback read-back cannot help when STT confidence is
`null`; the local and Sarvam providers report no confidence. The current
Arunodhaya qualification schema explicitly confirms `monthly_bill` and
`phone`. Other captured values such as a name can remain unconfirmed when
confidence is null. Booking slot selection is matched from the caller’s
utterance and booking executes after a matching offered slot; the booking step
then narrates the verified result. The booking step now requires a separate
clear confirmation of the exact offered date/time before booking; regression
tests cover selection, confirmation, ambiguity, and rejection. The Arunodhaya
qualification schema already marks phone as confirmed, and its no-confidence
test covers that field. Names and other fields remain governed by their tenant
schema.

## Generated TTS additions

The following additional listening files are generated locally from the
installed manifest, with no model download. Telugu files use sherpa-onnx
`te_IN-venkatesh-medium` and English uses sherpa-onnx
`en_US-joe-medium`; runtime is sherpa-onnx 1.13.8 and both are at 22,050 Hz
mono PCM. The manifest identifies
the STT model as `sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-v2-int8-2026-02-05`
(SHA-256 `e3042b2f3b3ef0af2211bf99d2b4bf94a21f5ac0e9898827e7dd6d003a860e91`).
The Telugu and English TTS model files have SHA-256 values
`f84931d244c5ef4d7e1b62ed6a7664526dca06dad6c66a818e283563af440f70` and
`c9dc0dd883bd662937e8986af97efb25636c557469bde904dc4fcc9344cd2918`,
respectively.
They are machine-generated samples; they have no reviewer scores yet.

| File | Exact text | Model / voice | Review focus |
| --- | --- | --- |
| `models/local-speech-benchmark/tts-samples/review-packet/te_short.wav` | నమస్కారం, మీకు ఏ సమాచారం కావాలి? | sherpa-onnx 1.13.8 Piper `te_IN-venkatesh-medium` | Short natural Telugu; respectful `మీకు` |
| `models/local-speech-benchmark/tts-samples/review-packet/te_long.wav` | నమస్కారం. వచ్చే సోమవారం ఉదయం పది గంటలకు మీ సైట్ విజిట్‌ను నమోదు చేయాలా? దయచేసి తేదీ, సమయం సరైనవో చెప్పండి. | sherpa-onnx 1.13.8 Piper `te_IN-venkatesh-medium` | Long utterance, date/time phrasing, pacing |
| `models/local-speech-benchmark/tts-samples/review-packet/te_name_date_time.wav` | శ్రీలక్ష్మి రెడ్డి గారికి, మార్చి ఇరవై నాలుగో తేదీ ఉదయం పది గంటలకు అపాయింట్‌మెంట్ ఉంది. | sherpa-onnx 1.13.8 Piper `te_IN-venkatesh-medium` | Telugu name, calendar date, time |
| `models/local-speech-benchmark/tts-samples/review-packet/te_phone.wav` | మీ ఫోన్ నంబర్ తొమ్మిది ఎనిమిది ఏడు ఆరు ఐదు నాలుగు మూడు రెండు ఒకటి సున్నా అని నమోదు చేశాను. ఇది సరైనదేనా? | sherpa-onnx 1.13.8 Piper `te_IN-venkatesh-medium` | Digit-by-digit intelligibility and confirmation tone |
| `models/local-speech-benchmark/tts-samples/review-packet/te_booking.wav` | శనివారం సాయంత్రం ఐదు గంటలకు సైట్ విజిట్ బుక్ చేయాలా? అవునంటేనే బుకింగ్ పూర్తి చేస్తాను. | sherpa-onnx 1.13.8 Piper `te_IN-venkatesh-medium` | Booking intent and conditional wording |
| `models/local-speech-benchmark/tts-samples/review-packet/en_switch.wav` | I will confirm the appointment time now. | sherpa-onnx 1.13.8 Piper `en_US-joe-medium` | English voice quality and transition consistency; pair with `te_booking.wav` |

Score each TTS item 1–5 for intelligibility, naturalness, pronunciation,
pacing, and (where paired) consistency across the Telugu/English switch. Add
the exact word or sound that was unclear. `5` means acceptable for a customer
call; `1` means unusable. A Telugu-fluent reviewer should listen once without
the text and once with the text. Acceptance requires no critical date, time,
phone, or booking wording error and at least 4/5 from each reviewer on
intelligibility and pronunciation; business approval is still required for
naturalness and voice consistency.

| Item | Intelligibility | Naturalness | Pronunciation | Pacing | Telugu/English consistency | Critical words correct? | Notes / exact unclear words |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
|  | /5 | /5 | /5 | /5 | /5 |  |  |

Reproduce or refresh the samples with:

```sh
.venv/bin/python scripts/generate-local-telugu-review-tts.py
```

The script writes only to the git-ignored benchmark sample directory and loads
the already-present `models/voice-local/manifest.json` models.

## Phase B.5 voice comparison (2026-10-14)

Same 28 synthetic lines, two Telugu voices, before and after the text-pipeline
fix. Exact text per line is in `scripts/local-tts-benchmark-phrases.json`
(`text` is what the voice was given; `ref` is what should be heard).
Files are 22,050 Hz mono WAV, machine-generated, **not yet heard by anyone**:

- `models/local-speech-benchmark/tts-te-voices/current/venkatesh/<id>.wav`
- `models/local-speech-benchmark/tts-te-voices/current/padmavathi/<id>.wav`
- `models/local-speech-benchmark/tts-te-voices/legacy/<voice>/<id>.wav` (pre-fix, for comparison)

Listen first to `c01-meeku`–`c04-neeku-monday` (is మీకు clearly different
from నీకు, in both voices?), then `d01`–`d04` (every digit, in order), `t01`–`t06`
(date and time), `p01`–`p03` (amounts), `b01`, `x01`, `m01`–`m03` (voice
switch; Padmavathi switches to a male American English voice). Score each with
the TTS table above and also mark whether the Telugu wording itself is natural
(year-first dates, `గంటల … నిమిషాలు` times, `నుంచి` ranges, `ఒక లక్ష …`
amounts) — those renderings were chosen by an engineer, not a Telugu speaker.
Which voice to use, and whether the voice switch is acceptable, are reviewer
and owner decisions.

## Blinded voice comparison, packet `b6` (2026-10-14)

A shorter, blinded version of the comparison above is ready: 22 gain-matched
clips (94 s) with the voice labels hidden, a మీకు/నీకు forced-choice part
without text, and seven booking-critical lines as voice pairs. Protocol,
reviewer sheet location and the exact acceptance criteria are in
[`LOCAL_TELUGU_TTS_BLIND_REVIEW.md`](LOCAL_TELUGU_TTS_BLIND_REVIEW.md); the
wording questions for the same reviewers are in
[`LOCAL_TELUGU_TTS_REVIEWER_DECISIONS.md`](LOCAL_TELUGU_TTS_REVIEWER_DECISIONS.md).
No reviewer has listened yet.
