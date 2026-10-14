# HALO Telugu speech review form

**Status: blank reviewer form. No one has scored these samples.** Each Telugu-
fluent reviewer should fill a separate copy. Record reviewer code (not a
personal name), Telugu fluency, date, and audio playback device. Listen once
without reading the text, then again while reading it. Do not discuss scores
until reviewers submit independently.

## TTS listening score

Score 1–5: `1` unusable, `2` frequent confusion, `3` understandable with
effort, `4` clear with minor issues, `5` clear and natural for a customer
call. For critical words, write exactly what you heard. `Switch` means whether
the transition between Telugu and English voices sounds consistent and
acceptable.

| ID | Audio file | Intelligibility /5 | Naturalness /5 | Pronunciation /5 | Pacing /5 | Switch /5 or N/A | Critical words correct? | Exact words heard / notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| T1 | `models/local-speech-benchmark/tts-samples/sherpa-piper-te_IN-venkatesh-medium/te.wav` |  |  |  |  | N/A |  |  |
| T2 | `models/local-speech-benchmark/tts-samples/sherpa-piper-te_IN-maya-medium/te.wav` |  |  |  |  | N/A |  |  |
| T3 | `models/local-speech-benchmark/tts-samples/sherpa-piper-te_IN-padmavathi-medium/te.wav` |  |  |  |  | N/A |  |  |
| T4 | `models/local-speech-benchmark/tts-samples/sherpa-split/mix.wav` |  |  |  |  |  |  |  |
| T5 | `models/local-speech-benchmark/tts-samples/sherpa-piper-te_IN-maya-medium/mix-translit.wav` |  |  |  |  | N/A |  |  |
| T6 | `models/local-speech-benchmark/tts-samples/sherpa-piper-en_US-joe-medium/en.wav` |  |  |  |  | N/A |  |  |
| P1 | `models/local-speech-benchmark/tts-samples/review-packet/te_short.wav` |  |  |  |  | N/A |  |  |
| P2 | `models/local-speech-benchmark/tts-samples/review-packet/te_long.wav` |  |  |  |  | N/A |  |  |
| P3 | `models/local-speech-benchmark/tts-samples/review-packet/te_name_date_time.wav` |  |  |  |  | N/A |  |  |
| P4 | `models/local-speech-benchmark/tts-samples/review-packet/te_phone.wav` |  |  |  |  | N/A |  |  |
| P5 | `models/local-speech-benchmark/tts-samples/review-packet/te_booking.wav` |  |  |  |  | N/A |  |  |
| P6 | `models/local-speech-benchmark/tts-samples/review-packet/en_switch.wav` |  |  |  |  |  |  |  |

Check each supplied text against the prompt in
`LOCAL_TELUGU_HUMAN_REVIEW_PACKET.md`. For P3–P5, a wrong name, date, time,
phone digit, negation, or booking condition is a critical error regardless of
the average score. Compare P5 and P6 for voice-switch consistency. Do not
award naturalness points based on transcript intelligibility alone.

## STT recording review

The verified reference transcript and stable prompt ID are in
`LOCAL_TELUGU_RECORDING_MANIFEST.csv`. For each speaker/take, first verify the
spoken words against that reference. Preserve the actual wording in the
transcript field if the speaker naturally deviated; do not silently edit the
reference. Record the candidate’s raw output verbatim and mark critical-token
accuracy independently of WER/CER.

| Recording ID | Reference verified? | Raw STT output | WER | CER | Telugu script correct? | Name exact? | Date exact? | Time exact? | Phone digits exact? | Negation / cancel / reschedule correct? | Human correction needed? | Failure notes |
| --- | --- | --- | ---: | ---: | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |  |  |  |  |  |

Score WER/CER separately for Telugu and Tenglish, at native and emulated
8 kHz. NFC-normalize, lowercase, remove punctuation and Telugu joiners, and
collapse whitespace. Preserve raw text. Do not normalize digit words to
numerals for the primary WER/CER; additionally report exact numeric-field
accuracy after a separately described normalization. A script error is any
non-Telugu script letter in Telugu output or non-Latin script letter in
English output; report Tenglish script distribution rather than requiring one
script.

## Reviewer conclusion

- Critical errors observed (clip IDs and exact error): ____________________
- Mean intelligibility / pronunciation / naturalness / pacing: ____________
- Voice-switching acceptable? ___________________________________________
- Would you allow this result to finalize a booking without a human correction?
  Yes / No — explain: ___________________________________________________
- Reviewer fluency and date: ____________________________________________

Acceptance requires meeting the objective criteria in the review packet and
business approval. A reviewer opinion alone does not change status to
accepted; compile all independent forms and the verified audio manifest first.
