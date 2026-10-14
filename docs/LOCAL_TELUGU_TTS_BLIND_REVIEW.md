# Blinded local Telugu TTS review — Venkatesh vs Padmavathi (packet `b6`)

**Status (2026-10-14): packet built, not yet reviewed. No human has listened
to any clip. No result in this file or anywhere else is a human result.**
Sarvam remains the production primary for STT and TTS; this review only
decides whether a *local* Telugu voice is acceptable as a fallback, and which
one. Production routing and `models/voice-local/manifest.json` (Venkatesh) are
unchanged.

## What is in the packet

Everything is git-ignored under `models/` (synthetic phrases only, no customer
data):

| Path | Who gets it |
| --- | --- |
| `models/local-speech-benchmark/blind-review/b6/clips/*.wav` (22 clips, 94 s) | reviewers |
| `models/local-speech-benchmark/blind-review/b6/REVIEW_SHEET.md` | reviewers (print or copy) |
| `models/local-speech-benchmark/blind-review/b6/clips.sha256` | reviewers, to confirm they have the right files |
| `models/local-speech-benchmark/blind-review-keys/b6.key.json` | **the person running the review only** |

- **Part A — మీకు/నీకు forced choice, no text (8 clips).** Lines `c01`–`c04`
  of `scripts/local-tts-benchmark-phrases.json` (మీకు/నీకు ఏ సమాచారం కావాలి?,
  మీకు/నీకు సోమవారం వీలవుతుందా?) in both voices, shuffled.
- **Part B — 7 booking-critical lines, both voices per line (14 clips):**
  phone digits (`d01`), numeric date (`t01`), colon time (`t03`), time range
  (`t05`), booking confirmation (`b01` with date and time, `b02` with the
  yes-before-booking wording) and cancellation (`x01`). Line order and the
  `-1`/`-2` voice assignment are random per item. The reviewer first writes
  what they heard without the text, then scores with the text.

Audio source: benchmark run `b6-current` (2026-10-14 15:13 IST, current text
pipeline, sherpa-onnx 1.13.8, Piper `te_IN-venkatesh-medium` /
`te_IN-padmavathi-medium` with `en_US-joe-medium` for Latin-script words,
22,050 Hz mono). The text plans for these lines are identical to the B.5
`current` run. Clips are gain-matched to −23 dBFS active-speech RMS (gains
−6.0 to +0.2 dB, none peak-limited) so loudness cannot decide the preference.
The key records each clip's voice, source WAV and both SHA-256 sums.

**Limits of the blinding.** It hides the label, not the voice. Venkatesh
sounds male and Padmavathi female, and Padmavathi's clips in this packet are
18 % longer in total (51.0 s vs 43.1 s) for the same text, so a reviewer who learns which voice is which can
tell them apart. Keep the key away from reviewers, do not tell them the voice
names, and collect every sheet before discussing. For a second round, rebuild
with a new private seed:

```sh
.venv/bin/python -I scripts/build-local-tts-blind-review.py --source b6-current --name <new-name> --seed <private>
```

## How to run it

1. At least **two** Telugu-fluent reviewers, at least one a native speaker;
   none of them has worked on HALO's Telugu wording. Record fluency on the sheet.
2. Each reviewer listens alone, on the device callers would use (phone speaker
   or a basic headset) and once on headphones, and fills in `REVIEW_SHEET.md`.
   Part A before Part B; in Part B, the no-text pass before reading the text.
3. The organiser collects all sheets, *then* unblinds with `b6.key.json`, and
   records results below, verbatim, per reviewer. Do not average away a
   critical error.
4. The same reviewers fill in the decision columns of
   [`LOCAL_TELUGU_TTS_REVIEWER_DECISIONS.md`](LOCAL_TELUGU_TTS_REVIEWER_DECISIONS.md).

## Acceptance criteria for a local Telugu voice (per voice)

A voice is **accepted as the local fallback** only if every item holds, for
every reviewer:

1. **Part A:** all 4 of that voice's clips identified correctly (మీకు as
   మీకు, నీకు as నీకు). One wrong answer or *unclear* fails the voice; a
   respectful-form error on a customer call is not acceptable.
2. **Part B, no-text pass:** for all 7 lines, every phone digit in order, the
   date (day and month), every time including ఉదయం/సాయంత్రం, and the
   booked/cancelled meaning written down correctly. Zero critical errors
   (the bar already set in `LOCAL_TELUGU_HUMAN_REVIEW_PACKET.md`).
3. **Part B, scores:** intelligibility ≥ 4/5 and pronunciation ≥ 4/5 on every
   line (existing packet bar).
4. Naturalness, pace, the reviewer's preference, and whether the
   Telugu→English voice switch (for Padmavathi, female→male) is acceptable are
   **recorded, not pass/fail**. The business owner decides on them.
5. Every row of `LOCAL_TELUGU_TTS_REVIEWER_DECISIONS.md` has a reviewer entry
   (keep, replacement wording, or *ask owner*). Any replacement is implemented
   in both text pipelines and the shared fixture, and the changed lines are
   re-synthesized and re-heard before acceptance.
6. Owner sign-off: which voice (if either), whether the voice switch is
   acceptable, and the Padmavathi CC-BY-4.0 attribution if it is chosen.

If both voices pass, the preference counts and the owner choose. If neither
passes, the local path stays an outage-only fallback that is **not**
described as customer-ready, and Sarvam remains the only accepted Telugu
voice.

Not covered by this packet, and still needed before the local path is
"accepted" overall: booking codes, month-first dates, price ranges and the
other new renderings (hear `tts-te-voices/b6-regression/`; decide via the
decisions list), the STT human-recording bar in
`LOCAL_TELUGU_HUMAN_REVIEW_PACKET.md`, and a live phone-line (8 kHz) listen.

## Results

| Reviewer | Fluency | Date | Part A Venkatesh (x/4) | Part A Padmavathi (x/4) | Part B critical errors V / P | Min intelligibility V / P | Min pronunciation V / P | Preference | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| *(none yet)* | | | | | | | | | |
