# HALO — local speech (Phase B)

**Status: IMPLEMENTED, but Phase B is not complete.** The current local STT
model remains materially below Sarvam for Telugu, and the local TTS samples
have not been human-auditioned. Selecting `local` is an availability decision,
not a quality claim.

Local speech lets HALO transcribe and speak with no speech vendor and no
credential: open models run in-process through
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). Sarvam remains the
reference path and is unchanged.

Everything below was measured on 2026-10-07 on one machine — Intel i5-8265U
(4 cores / 8 threads), 4.8 GB RAM, WSL2, no GPU — which was also running the
browser, the Next server, two Supabase stacks and the test driver. No human
listened to any audio: the machine has no audio output. Read every quality
statement with that in mind.

## What was chosen

| | Model | Runtime | Disk | Licence |
| --- | --- | --- | --- | --- |
| STT | Omnilingual ASR 300M CTC v2, int8 (`sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-v2-int8-2026-02-05`) | sherpa-onnx 1.13.8 | 366 MB | Model Apache-2.0 (Meta); runtime Apache-2.0 |
| TTS, Telugu | Piper `te_IN-venkatesh-medium` (VITS) | sherpa-onnx | 61 MB | Dataset IndicVoices-R, CC-BY-4.0 |
| TTS, English | Piper `en_US-joe-medium` (VITS) | sherpa-onnx | 61 MB | Dataset CC0 |
| Phonemizer data | espeak-ng-data | bundled in sherpa-onnx | 19 MB | espeak-ng is GPL-3.0 |

Total about 0.55 GB (0.61 GB with the download cache the setup script keeps).

Licence notes to settle before a commercial deployment:

- sherpa-onnx itself is Apache-2.0 but phonemizes Piper voices with a bundled
  espeak-ng, which is **GPL-3.0**. Shipping it has GPL obligations.
- The voices' training data is CC-BY-4.0 / CC0; the voice files come from the
  community `rhasspy/piper-voices` repository and carry no separate licence
  text of their own. The Telugu voices were trained by a third party.
- Voices rejected on licence: `en_US-lessac` (Blizzard 2013 research licence),
  `en_US-ryan` and `hfc_male` (CC-BY-NC-SA), `te_IN-maya` (IndicTTS licence,
  not reviewed). MMS TTS was not considered: CC-BY-NC.

## How it is wired

Nothing in `packages/runtime` changed, and it still cannot tell which speech
provider is running.

- **Pipecat worker** (the browser and carrier path):
  `services/pipecat-worker/local_speech.py` adds `LocalSTTService` and
  `LocalTTSService` behind the same Pipecat service interfaces the Sarvam
  services implement. `_build_stt` / `_build_tts` in `worker.py` select them.
- **Gateway** (in-process engine, `/web/stt`, `/web/tts`):
  `packages/providers/voice-vendors/local-stt-provider.ts` and
  `local-tts-provider.ts` implement the existing `StreamingSttProvider` /
  `StreamingTtsProvider` ports and pass the same contract kit as the fakes
  and Sarvam. `sherpa-onnx-node` is an optional dependency loaded on first use.
- Both read one model directory and its `manifest.json`. No model is chosen
  by a default in code.

### Configuration

```bash
# One-time: download, checksum and convert the models (about 0.55 GB).
.venv/bin/python -m pip install -r services/pipecat-worker/requirements.txt
.venv/bin/python services/pipecat-worker/setup_local_speech.py models/voice-local
```

| Variable | Meaning |
| --- | --- |
| `VOICE_STT_PROVIDER`, `VOICE_TTS_PROVIDER` | `sarvam` \| `local` \| `fake`. Read by the gateway and the worker. |
| `VOICE_STT_FALLBACK_PROVIDER`, `VOICE_TTS_FALLBACK_PROVIDER` | Optional. One fallback, different from the primary. |
| `VOICE_LOCAL_MODEL_DIR` | Required when `local` is the primary or the fallback. |
| `VOICE_LOCAL_THREADS` | Inference threads, default 4. |

The worker still honours `HALO_SPEECH_PROVIDER` as a worker-wide default; the
per-kind names above win when both are set. Tenant profiles
(`VOICE_PROFILES_JSON`) may name `local` and a `modelDir` too.

Local mode needs no speech credential. The browser run below was made with
every Sarvam variable blanked in the gateway's and the worker's environment.
(The LLM still needs its own key; that is not a speech provider.)

### Fallback rules

A fallback is taken only for an **explicitly recoverable provider failure**:
the provider was unreachable, timed out, was rate-limited or failed
server-side (or, for a local model, inference faulted or timed out).

It is never taken for:

- a missing credential, model directory or model file — the gateway and the
  worker refuse to start instead;
- a rejected credential (401/403), an unsupported language or voice;
- an error nobody classified, or a provider that throws where the port says
  it must not (a defect).

Behaviour when it is taken:

- **Worker:** Pipecat's own `ServiceSwitcher`, with a strategy
  (`speech_fallback.py`) that switches once and never back, for the rest of
  that call. The next call starts on the primary again. The utterance or line
  that failed is reported as failed and is **not replayed** into the fallback.
- **Gateway:** the existing `FallbackSttProvider` / `FallbackTtsProvider`,
  which replay only before the first final / before any audio is released.

- **Gateway outage memory** (`provider-circuit.ts`, in-process engine and
  web speech): after 2 consecutive recoverable failures the primary is skipped
  for 30 s, then one request probes it; a working probe returns speech to the
  primary, a failed one doubles the wait (5 min cap). Non-recoverable errors,
  defects and barge-ins never count. State is per gateway process, per
  provider chain (the default chain, and one per tenant profile); it is not
  shared between gateway instances and is lost on restart. The values are
  constructor options, not environment variables. With real Sarvam adapters
  against a local socket that never answers, six lines took 30.8 s to first
  audio without it and 10.0 s with it (two 5 s connect timeouts, then 0 ms);
  six STT stream opens likewise 30.8 s against 10.0 s. A call whose STT
  stream opens while the circuit is open stays on the fallback recognizer for
  that call. The worker has no equivalent: each call starts on the primary.
  Outage-to-recovery is covered by `tests/integration/speech-outage-recovery.test.ts`
  (real Sarvam adapters against `tests/mocks/sim-sarvam.ts` on loopback). In a
  timed run with a 10 s cooldown and one line per second, the only waits were
  the two 5 s timeouts that opened the circuit and one 5 s failed probe;
  Sarvam came back at 30 s and was used again from 45 s, because the failed
  probe had doubled the wait. With the default 30 s cooldown that lag can
  reach the current cooldown, at most 5 minutes.
- **Read-back does not depend on the provider, because no provider reports
  confidence.** The confidence-gated read-back (`system-action.ts`, below 0.6)
  and the consecutive-low-confidence signal need a transcript confidence;
  Sarvam's realtime endpoint and the local model both report none, so neither
  fires on a real call, primary or fallback. What remains is the tenant
  schema: for Arunodhaya only `monthly_bill` and `phone` are `confirm: true`.
  A name, an area or a capacity heard by the weaker local recognizer is stored
  unconfirmed (`tests/unit/voice/readback-without-confidence.test.ts`).

Two behaviours changed to meet these rules, both outside the Phase A path
(which configures no fallback):

1. The fallback wrappers used to switch on *any* error, including
   non-retryable ones and a provider that threw from `open()`. They now
   switch only on a retryable error or an unexpected close.
2. A tenant profile naming Sarvam with no credential and a `fallback` used to
   use the fallback silently. It is now a configuration error.

## Local STT — honest limits

- **Not streaming.** The model is an offline CTC recognizer. No Telugu-capable
  candidate that fits this machine streams. There are no interim results, no
  provider endpointing and no confidence; HALO gets one final per VAD segment.
- **Telugu is much weaker than Sarvam** (table below): about one character in
  four wrong on human read speech at the 8 kHz wire band.
- **Spoken digits are unreliable.** A Telugu phone number came back as
  `నా ఫోన్ నంబర 9ొమ్మిది 8ిమిది నాగు ...`. Do not trust a number or a name
  captured through local STT without a read-back. Because the model reports
  no confidence, HALO's low-confidence read-back does not fire by itself.
- **Wrong script, occasionally.** The model is language-agnostic and one of
  eight human Telugu clips came back in Devanagari; in the live call some
  Telugu lines carried stray Devanagari letters.
- **Tenglish** is transcribed in Telugu script (`ఆఫీస్ టైమింగ్స్`), never as
  Latin words. HALO therefore does not see it as code-mixed.
- English is close to usable; accented or noisy speech was not tested.

## Local TTS — honest limits

- **Intelligible, naturalness unknown.** Sarvam's recognizer transcribed the
  local Telugu and English sentences exactly, so the words are there. Nobody
  has listened to it. Do not describe the voice as natural or pleasant on
  this evidence. Piper `medium` voices are generally plainer than Sarvam's.
- **Two voices in one sentence.** The Telugu voice mispronounces English
  words written in Latin letters (`office timings` was heard back as
  `అసిస్ట్ టైమింగ్స్`), so Latin-script runs are spoken by the English voice.
  That fixes intelligibility and means the speaker changes mid-sentence.
- **The English voice is American**, not Indian English.
- **Sentence-level, not streaming.** A whole segment (a sentence, a clause of
  a long sentence, or a script run) is synthesized before any of it plays.
  Each segment's own edge silence is trimmed and a fixed pause inserted
  after it (280 ms sentence, 160 ms clause, 40 ms voice switch); the values
  were not changed by tuning because the only available judge, the local
  recognizer, cannot tell them apart (`LOCAL_SPEECH_BENCHMARK.md`, Phase B.5).
- **Telugu and English only.** A line no installed voice can speak (for
  example Hindi) fails as `unsupported_language`; it is not read out as
  letter names. Agent `voice.ttsVoice` is ignored: a vendor speaker name has
  no meaning here.
- **Numbers are written out before synthesis** (`local_tts_text.py` /
  `local-tts-text.ts`, kept identical by a shared fixture): phone numbers
  digit by digit, dates, times, prices, percentages, units and common
  abbreviations as words in the language of the surrounding words. Before
  this, espeak read `9876543210` as one cardinal in crores and `24/03/2026`
  with the slash as a word. Booking codes (`AR-2041`) are spelled character
  by character by the English voice; a numeric date is day-first unless only
  month-first is valid (`03/24/2026`), and an impossible date is read digit
  by digit. The Telugu renderings have not been checked by a native speaker;
  the open choices are listed in `LOCAL_TELUGU_TTS_REVIEWER_DECISIONS.md`.

## Benchmark

26 clips: 8 Telugu and 8 English human read-speech clips (FLEURS validation,
3.6–5.3 s), plus 10 receptionist sentences (3 Telugu, 3 English, 4 Tenglish)
spoken by Sarvam TTS. Scores ignore punctuation. `8 kHz` means the clip was
reduced to the wire band first, which is what the worker receives.

### STT candidates (4 threads)

| Candidate | Disk | Peak RAM | Decode p50 | Telugu CER 16k / 8k | English WER 16k / 8k | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| whisper.cpp tiny q5_1 | 32 MB | 167 MB | 1.5 s | 93 / 101 % | 26 / 28 % | Telugu comes back in the wrong script |
| whisper.cpp base q5_1 | 60 MB | 234 MB | 3.1 s (max 25 s) | 94 / 90 % | 21 / 23 % | Same; hallucination loops |
| whisper.cpp small q5_1 (7 clips, 8k) | 190 MB | 500 MB | 60 s | – / 87 % | – / 4 % | Good English; Telugu garbage; 15× slower than real time |
| sherpa-onnx Whisper base int8 | 160 MB | 823 MB | 1.3 s | 93 / 92 % | 22 / 23 % | Same model family, same Telugu failure |
| sherpa-onnx Dolphin base CTC int8 | 100 MB | 270 MB | 0.2 s | 28 / 32 % | unusable | Fast, no English, mixes scripts |
| **sherpa-onnx Omnilingual 300M CTC int8** | 366 MB | 669 MB | 1.2 s | **18 / 26 %** | **15 / 17 %** | **Chosen** |

None of these streams Telugu. Larger models (Omnilingual 1B, Whisper medium)
were not downloaded: they do not fit this machine's free memory.

### Chosen STT against Sarvam (through the implemented engine, 8 kHz wire band)

| | Local WER / CER | Sarvam WER / CER (16 kHz) |
| --- | --- | --- |
| Telugu, human read speech (8) | 78 % / 25 % | – |
| Telugu, synthetic receptionist lines (3) | 43 % / 9 % | – |
| Telugu, all (11) | 67 % / 20 % | 6 % / 2 % |
| English, all (11) | 17 % / 7 % | 13 % / 9 % ¹ |
| Tenglish (4), against Sarvam's own transcript | CER 12 % | – |

¹ Sarvam's English errors here are mostly digit formatting (`10` for `ten`).

Local decode p50 was 1.0 s for Telugu and 1.3 s for English, with all four
cores busy for the duration. Sarvam returned a final 0.25–0.4 s after the end
of speech (p50).

### TTS candidates

| Candidate | First audio (p50) | Real-time factor | Peak RAM | Notes |
| --- | --- | --- | --- | --- |
| Piper `te_IN-maya` / `padmavathi` / `venkatesh` (piper-tts) | 0.6 / 0.5 / 0.3 s | 0.12 / 0.11 / 0.09 | 289 / 308 / 238 MB | All three Telugu sentences transcribed exactly by Sarvam STT |
| The same voices through sherpa-onnx | 0.5 / 0.4 / 0.3 s | 0.16 / 0.11 / 0.11 | same | Same audio; one runtime for STT and TTS, so **chosen** |
| Piper `en_US-lessac` | 0.3 s | 0.10 | 226 MB | Rejected on licence; its int8 build ran 4× slower |
| KittenTTS nano int8 (sherpa-onnx) | 2.6 s | 0.56 | 187 MB | English only and slow |
| **Piper `en_US-joe`** (sherpa-onnx) | 0.3 s | 0.10 | 227 MB | **Chosen** for English |

Through the implemented engine, with STT and both voices loaded: first audio
p50 0.7 s (max 0.8 s), real-time factor 0.22. Sarvam TTS on the same
sentences: first audio 0.35–1.4 s (p50 about 0.5 s).

### Memory and CPU

| | Sarvam mode | Local mode |
| --- | --- | --- |
| Worker RSS, idle | 100–160 MB | 760 MB (models preloaded at startup) |
| Worker RSS, peak during a call | – | 1.2 GB |
| Worker startup | instant | about 10 s (6 s STT + 4 s voices) |
| CPU during inference | negligible | all 4 cores, about 1 s per utterance and 0.3–0.8 s per sentence |
| CPU idle | 0 % | 0 % |

The gateway loads its own copy of the models only if its own speech path is
used (`/web/stt`, `/web/tts` or the in-process engine); with the Pipecat
engine it loads nothing. STT and TTS never run at the same time in one
process: on four cores, running both made each several times slower.

## Browser voice path

The real widget in headless Chromium, with the microphone replaced by
synthesized caller clips (`getUserMedia` fed from WebAudio). Same nine-step
script and the same clips as the Phase A reference run. Local run: gateway
and worker in local mode with every Sarvam variable blank.

| | Sarvam reference | Local |
| --- | --- | --- |
| Call outcome | completed | completed |
| Caller turns transcribed | 12 | 11 |
| HALO turn time | 0.9–4.0 s, median 1.2 s | 3.1–15.3 s, median 7.5 s |
| Reply audio after the caller stops | 1.6–2.6 s | 3.9–17.2 s |
| Barge-in: playback cleared after | 1.4 s | 1.0 s |
| Language followed Telugu ↔ English | yes | yes |
| Human handoff requested and executed | yes | yes |

What the local run showed:

- It works end to end: greeting, Telugu, Tenglish and English turns, a
  barge-in that cut playback, and the handoff.
- It is slow. In-call decodes took 0.6–6.8 s for 1–6 s of speech, several
  times the isolated benchmark, because the same four cores were also running
  the browser and everything else. On a host that is not also the client it
  should be closer to the benchmark; that was not measured.
- Recognition errors reached the agent. `What are your working hours on
  Saturday` arrived as `wat im wolking asm sateby` and the agent asked the
  caller to repeat; `Do you also service air conditioners?` arrived as
  `breo also serवice a conditiones`.
- Two turns got HALO's "having trouble connecting" line because the LLM
  provider timed out. That is unrelated to speech.

Not verified: a human microphone, a human listener, a real phone line, more
than one concurrent call, long calls, and any host other than this laptop.

Two defects were found and fixed by the first live runs, both in the new
worker services: a slow decode blocked the frame path so a line HALO wanted
spoken timed out, and a synthesis slower than three seconds was closed as an
empty playback. Both ended the call. Both now have tests.

## Human audition runbook

The WAVs are mono, 16-bit PCM at 22,050 Hz (the KittenTTS English sample is
24,000 Hz); they range from 2.54 to 4.79 seconds and are 5.5 MB total. They
remain in the ignored `models/local-speech-benchmark/tts-samples/` directory.
No one has listened to them yet.

On Windows with the repository available to PowerShell and an audio output
device, run this from the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\play-local-speech-samples.ps1
```

The playlist plays 24 samples: the sherpa split-voice production setup, all
three Telugu voices through both sherpa-onnx and Piper, plus the English Joe
voice through both runtimes. It includes Telugu, English, Tenglish in Latin
script, and Tenglish with English words written in Telugu script. For each
sample, note pronunciation (especially `మీకు`), naturalness, and whether the
Tenglish voice change is acceptable. The script uses Windows PowerShell's
built-in `System.Media.SoundPlayer`; it downloads or installs nothing. Stop
with Ctrl+C. Please report which Telugu voice and which Tenglish treatment
you prefer, and whether the English voice is acceptable for the intended
callers.

The Windows playback route is documented for this WSL checkout, where no
Linux audio player was found. Playback has not been performed or quality
assessed by this runbook's author. The WSL-to-Windows PowerShell launch could
not be validated in this environment, so run the script from native Windows
PowerShell if that integration is unavailable.

## Recommendation

Use `sarvam` as the primary. `local` is wired as an explicit fallback and is
useful for credential-free development, but its suitability as a production
fallback for Telugu calls is not accepted: STT quality is substantially worse
than Sarvam, and TTS still needs human assessment. Configure it as a production
fallback only if that degradation is acceptable for the specific use case.

## Telugu acceptance status (2026-10-14)

**Engineering follow-up complete; human acceptance pending.** The original
FLEURS audio and clip manifest could not be recovered from this checkout or
its documented scratchpad/cache locations. The fresh 9-clip run uses only
synthetic Sarvam-TTS audio and is recorded separately in
`LOCAL_TELUGU_STT_HUMAN_REVIEW.md`; it is not a human-speech result. New local
TTS listening files and a consented recording protocol are in
`LOCAL_TELUGU_HUMAN_REVIEW_PACKET.md`. Do not mark Telugu speech accepted until
the stated native-speaker review criteria are met.

The scheduling action now reads the exact offered visit date/time back and
requires a clear confirmation before booking. Arunodhaya already requires a
phone-number read-back through its field schema, including when the recognizer
reports no confidence. No broad tenant-policy change was made; Sarvam remains
the primary provider.
