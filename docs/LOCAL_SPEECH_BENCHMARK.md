# HALO — Phase B.2 local speech shootout

**Date:** 2026-10-08. **Scope:** benchmark only. No HALO code, provider,
runtime or transport was changed, and nothing was committed.

**Result in one paragraph.** A usable local Telugu recognizer exists for this
machine: the IIT Madras Telugu fine-tune of Whisper *base*
(`vasista22/whisper-telugu-base`, 60 MB) run with whisper.cpp. On the same
audio it makes roughly a third to a half of the errors of the current
Omnilingual model, keeps Telugu in Telugu script every time, and transcribed a
spoken phone number correctly. It is still well behind Sarvam (about 28 % word
errors on human Telugu against Sarvam's 6 %, and 1.0–1.7 s after the caller
stops against 0.2 s), it is Telugu-only, and it is not wired into HALO. Sarvam
stays primary. Local TTS could not be ranked on quality because nobody has
listened to it; the samples are saved for that.

## Read this first: limits of the evidence

- **The nine corpus utterances are synthetic.** This machine has no
  microphone, so the nine sentences were spoken once by Sarvam TTS (16 kHz)
  and those nine files were reused for every candidate. Synthetic speech is
  cleaner than a caller.
- **Human speech was added as a check**: the 16 FLEURS read-speech clips
  (8 Telugu, 8 English) kept from Phase B. Read speech, studio-ish, not phone
  calls.
- **Tiny sample.** 3 + 3 + 3 corpus clips and 8 + 8 human clips. Differences of
  a few points mean nothing.
- **No native Telugu speaker reviewed any transcript, and no human listened to
  any audio.** The 0–5 scores below are my reading of the transcripts.
- **The machine was busy.** Load average was 3–5 from the development stack
  (Supabase, Next, Deno) during every run, so latencies are pessimistic
  against an idle host and realistic for this laptop.
- Not tested: real callers, phone audio, noise, accents, long utterances,
  silence (Whisper models can invent text on silence), concurrent calls.

## Setup

| | |
| --- | --- |
| Machine | Intel i5-8265U, 4 threads given to speech, 4.8 GB RAM (1.5–2.6 GB free during runs), WSL2, no GPU |
| Runtimes | whisper.cpp 1.8.5 via `pywhispercpp` 1.5.1; sherpa-onnx 1.13.8; piper-tts 1.8.0 |
| Process model | One candidate per process, run one after another; peak RAM is the process's peak resident size |
| Audio bands | `16k` = as synthesized; `8k` = reduced to the phone wire band, then back to 16 kHz (what the worker receives) |
| Language hint | Session language given to models that take one (`te` for Telugu and Tenglish, `en` for English) |
| Latency | Every candidate is offline: it decodes after the end of speech, so "latency after speech ends" is the decode time. VAD end-of-speech delay is not included. |

**Corpus (speech duration):** te-1 3.7 s, te-2 3.7 s, te-3 2.5 s, mix-4 1.8 s,
mix-5 2.5 s, mix-6 1.5 s, en-7 2.5 s, en-8 1.8 s, en-9 1.3 s. FLEURS clips are
3.6–5.3 s.

**Scoring.** WER and CER ignore punctuation and case. Tenglish is scored
against the closer of two references (Latin as written, or the same words in
Telugu script), because Sarvam and HALO write Tenglish in Telugu script.
Telugu WER counts spelling variants (`టీం`/`టీమ్`, `ప్యానల్`/`ప్యానెల్`) as whole
errors — Sarvam itself scores 11 % WER on its own audio that way — so **CER is
the more trustworthy Telugu number**.

Sarvam was called twice for this benchmark, once each way: 9 TTS requests to
make the corpus and 9 STT requests on it for a same-audio baseline. All other
Sarvam figures are the existing Phase B measurements.

## STT results

All at 4 threads. CPU during a decode was 3.7–4.0 cores for every candidate
(all four allotted threads busy; idle otherwise).

| # | Candidate | Disk | Peak RAM | Latency after speech, p50 (max) | Telugu corpus CER 16k / 8k | Telugu human 8k WER / CER | Tenglish CER 16k / 8k | English corpus WER 16k / 8k | English human 8k WER / CER | Telugu script correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| – | **Sarvam** (reference) | – | – | 0.20 s (0.32 s) | 1 % | 6 % / 2 % ¹ | 7 % | 0 % | 13 % / 9 % ¹ | yes |
| 1 | **whisper.cpp · whisper-telugu-base q5_1, ctx 512** | 60 MB | 170 MB | **1.0 s** (2.2 s) | **4 / 4 %** | **30 / 11 %** | 12 / 10 % | 100 / 100 % ² | 100 / 94 % ² | **yes** |
| 2 | whisper.cpp · whisper-telugu-base q5_1, ctx 768 | 60 MB | 177 MB | 1.7 s (2.3 s) | 3 / 4 % | 28 / 12 % | 12 / 10 % | 100 / 100 % ² | 100 / 93 % ² | yes |
| 3 | whisper.cpp · whisper-telugu-base q5_1, full context | 60 MB | 195 MB | 3.4 s (4.6 s) | 3 / 4 % | 28 / 11 % | 19 / 16 % | 100 / 100 % ² | 100 / 93 % ² | yes |
| 4 | whisper.cpp · whisper-telugu-small q5_1, ctx 768 | 190 MB | 363 MB | 6.0 s (10.2 s) | 4 / 4 % | 40 / 25 % | 12 / 18 % | 100 / 100 % ² | 99 / 96 % ² | yes |
| 5 | whisper.cpp · whisper-telugu-small q5_1, full context | 190 MB | 389 MB | 10.9 s (14.4 s) | 4 / 4 % | 40 / 25 % | 10 / 14 % | 100 / 100 % ² | 98 / 95 % ² | yes |
| 6 | sherpa-onnx · Omnilingual 300M CTC int8 (**current**) | 366 MB | 634 MB | 0.9 s (3.1 s) | 17 / 17 % | 78 / 24 % | 28 / 23 % | 33 / 33 % | 23 / 10 % | **no** — Gujarati, Devanagari, Gurmukhi mixed in |
| 7 | sherpa-onnx · Dolphin small CTC int8 | 250 MB | 489 MB | 0.3 s (0.7 s) | 73 / 66 % | 52 / 24 % | 77 / 77 % | 95 / 95 % | 100 / 100 % | no |
| 8 | sherpa-onnx · Dolphin base CTC int8 | 104 MB | 268 MB | 0.1 s (0.5 s) | 63 / 69 % | 102 / 33 % | 55 / 61 % | 100 / 95 % | 98 / 88 % | no |
| 9 | whisper.cpp · Whisper base q5_1 (stock), ctx 768 | 60 MB | 177 MB | 1.2 s (1.8 s) | 92 / 93 % | 115 / 93 % | 46 / 25 % | 14 / 14 % | 25 / 13 % | no — Arabic and Tamil letters |
| 10 | whisper.cpp · Whisper base q5_1 (stock), full context | 60 MB | 195 MB | 3.0 s (5.9 s) | 90 / 91 % | 172 / 142 % | 280 / 40 % | **0 / 0 %** | 21 / 11 % | no |
| 11 | whisper.cpp · Whisper tiny q5_1 (stock), ctx 768 | 32 MB | 131 MB | 0.7 s (2.1 s) | >100 % | >100 % | >100 / 47 % | 14 / 14 % | 31 / 16 % | no — Latin |
| 12 | whisper.cpp · Whisper tiny q5_1 (stock), full context | 32 MB | 147 MB | 1.9 s (3.8 s) | 98 / 97 % | 278 / 159 % | 27 / 27 % | 14 / 14 % | 29 / 14 % | no — Latin |
| 13 | whisper.cpp · Whisper small q5_1 (stock), corpus only | 190 MB | 386 MB | 10.0 s (16.9 s) | >100 % | not run | 88 / >100 % | 0 / 14 % | not run | no — Devanagari, Kannada, loops |
| 14 | sherpa-onnx · Whisper base int8 (stock) | 161 MB | 437 MB ³ | 1.0 s (4.4 s) | 90 / 91 % | 110 / 94 % | 42 / 70 % | 14 / 0 % | 22 / 10 % | no — Arabic and Tamil letters |
| 15 | sherpa-onnx · whisper-tiny-te int8 (ippocode pack) | 104 MB | 270 MB ³ | 0.5 s (1.8 s) | 100 % | 98 / 99 % | 100 % | 100 % | 100 % | **returned empty text** |

¹ Existing Phase B figure (Sarvam at 16 kHz, 11 Telugu / 11 English clips).
² The Telugu fine-tunes write everything in Telugu script, including English
(`హౌ లాంగ్ డస్ ఇన్స్టాలేషన్ టేక్` for "How long does installation take"), so they
score as wrong on English. They are Telugu-only models.
³ With one language loaded. Loading a Telugu and an English recognizer in one
process roughly doubled it (815 MB and 486 MB).

**Streaming / interim results:** none of the fifteen. Every one returns a
single final per utterance. No confidence score either.

### What the transcripts look like (8 kHz wire band)

| Clip | Reference | Sarvam (16 kHz) | #1 Telugu Whisper base, ctx 512 | #6 Omnilingual (current) | #9 stock Whisper base |
| --- | --- | --- | --- | --- | --- |
| te-1 | నమస్కారం, నాకు సోలార్ ప్యానెల్ గురించి సమాచారం కావాలి. | exact | నమస్కారం నాకు సోలార్ ప్యానల్ గురించి సమాచారం కావాలి | exact | `நமسکارم, نہ کسسولار پینل …` |
| te-2 | మీ దగ్గర ఇన్‌స్టాలేషన్ ఛార్జీలు ఎంత ఉంటాయి? | exact | exact | మీ దగ్గర ఇన్స్టాలేషన్ చార్జీలు ఎంత ఉంటాయి | `میدے گرا, Installation Charging lui emtountai.` |
| te-3 | రేపు మీ టీమ్ రావచ్చా? | exact | రేపు మీ టీం రావచ్చా | `रेपू मी टीम रावच्छा` (Devanagari) | `رےپு, میٹیم راوچہ` |
| mix-4 | Naaku solar panel price entha? | నాకు సోలార్ ప్యానెల్ ప్రైస్ ఎంత? | నాకు సోలార్ పైనన్ ప్రైస్ ఎంత | నాకు సోలార్ పానల్ ప్రయజ ంతా | `نہکு Soular Penal Price Enta.` |
| mix-5 | Installation ki entha time padutundi? | ఇన్స్టాలేషన్ కి ఎంత టైం పడుతుంది? | ఇన్స్టాలేషన్ కి ఎంత టైం పడుతుంది | ఇన్స్టాలేషన్ కీ ఎంతా టైమ పడుతుంది | Installing ki entha time podu tundi. |
| mix-6 | Meeru Saturday available aa? | మీరు సాటర్డే అవైలబులా? | మీరు సాటర్డే అవెలబుల్ ఆ | మీరు సాటడే అవెళుబులా | `میரு Saturday available` |
| en-7 | Hello, I want to know the price of a solar panel. | exact | హలో ఐ వాంట్ ప్రైస్ సోలార్ | hello i wan't to know the price of a solar panel | Hello, I want another price of a solar panel. |
| en-8 | How long does installation take? | exact | ఇన్స్టాలేషన్ టెక్ | how long does installation take | exact |
| en-9 | Are you available on Saturday? | exact | అరియో వెల్లబుల్ ఆన్సర్ అండ్ | `అరి o వelliబle an satedy` | exact |

On human Telugu (FLEURS, 8 kHz) candidate #1's errors are content words, for
example `మృతదేహం … పోలీసులు చెప్పారు` heard as `ప్రతి దేహం … పరిశుధులు చెప్పారు`, and
`కారు డీకొట్టినప్పుడు ముగ్గురు` as `పార్‌రెడ్డి కొట్టినప్పుడు మొక్కు`.

### Extra check: the Phase B receptionist clips (8 kHz)

Seven Telugu and Tenglish clips kept from Phase B, scored against Sarvam's own
transcript of the same audio.

| Clip | #1 Telugu Whisper base, ctx 512 | #6 Omnilingual (current) |
| --- | --- | --- |
| Appointment tomorrow at ten | exact (CER 0 %) | CER 4 % |
| Where is your office, what time do you open | exact (0 %) | 4 % |
| **Phone number, ten spoken digits** | **all ten digits right** (1 %; `నెంబర్` for `నంబర్`) | **67 %** — `నా ఫೋన్ నంర 984 8మ సున్న ఒ 2ె34గోయిదు` |
| Tenglish: appointment at ten | 2 % | 6 % |
| Tenglish: office timings, Sunday open | 0 % | 19 % |
| Tenglish: solar installation total cost | 8 % (dropped `కి`) | 10 % |
| Tenglish: cancel booking, reschedule next week | **26 %** — `క్యాన్సర్` for cancel, "reschedule" dropped | 10 % |

The last row matters: the leading candidate changed the meaning of one request.

### Manual quality scores (0–5, from reading transcripts; not a native review)

| Candidate | Telugu | Tenglish | English |
| --- | --- | --- | --- |
| Sarvam | 5 | 5 | 5 |
| #1–3 whisper.cpp Telugu Whisper base | **3** | **3** | 0 (Telugu-only) |
| #4–5 whisper.cpp Telugu Whisper small | 2–3 | 3 | 0 |
| #6 Omnilingual 300M (current) | 2 | 2 | 2 |
| #7–8 Dolphin small / base | 1 | 1 | 0 |
| #9–10 stock Whisper base | 0 | 1 | 3 |
| #11–12 stock Whisper tiny | 0 | 1 | 3 |
| #13 stock Whisper small | 0 | 0 | 4 (but 10 s) |
| #14 sherpa-onnx stock Whisper base | 0 | 0–1 | 3 |
| #15 sherpa-onnx whisper-tiny-te | 0 | 0 | 0 |

### Things that were not obvious

- **whisper.cpp's default decoding is unusable with the Telugu fine-tunes.**
  With library defaults the same base model took 3–38 s per clip and returned
  fragments (`�ే` for te-1). It needs `no_timestamps`, `single_segment` and
  no temperature fallback (`temperature_inc = 0`). Every whisper.cpp row above
  uses those settings.
- **`audio_ctx` is the latency lever.** Whisper encodes a padded 30 s window
  by default. Encoding only the first 10 s (`ctx 512`) cut the decode from
  3.4 s to 1.0 s with no accuracy loss here. Going lower (`ctx 384`) broke
  recognition. A `ctx 512` setting **cuts off anything after 10.2 s**, so it
  must be sized to the utterance.
- **Bigger was not better.** The Telugu *small* fine-tune scored worse than
  *base* on human Telugu (CER 25 % against 11 %) and took 6–11 s.
- Stock multilingual Whisper fails Telugu at every size tested (tiny, base,
  small), in both runtimes: wrong script or loops.

## TTS results

Sentences: Telugu `నమస్కారం, మీకు ఏ సమాచారం కావాలి?`, English `Sure, I can help
you with the installation details.`, Tenglish `మీకు solar panel price గురించి
తెలుసుకోవాలా?`. A fourth line was added: the same Tenglish sentence with the
English words in Telugu script (`సోలార్ ప్యానెల్ ప్రైస్`), to see whether one
Telugu voice can carry it.

Timings are the median of three runs. None of these streams: the whole
sentence is synthesized before any audio is available, so first-audio latency
and synthesis duration are the same number (within 20 ms). CPU during
synthesis was 3.7–4.0 cores.

| Candidate | Disk | Peak RAM | First audio = synthesis time: Telugu / English / Tenglish / Tenglish in Telugu script | Real-time factor | Machine check ⁴ |
| --- | --- | --- | --- | --- | --- |
| **Sarvam** (reference) | – | – | 0.29–0.59 s first audio today (p50 0.35 s); Phase B: 0.35–1.4 s | streams | – |
| Piper runtime · `te_IN-venkatesh-medium` | 64 MB | 210 MB | 0.35 / – / 0.36 / 0.39 s | 0.12 | Telugu exact; Tenglish 23 %; Telugu-script Tenglish 8 % |
| Piper runtime · `te_IN-maya-medium` | 63 MB | 238 MB | 0.44 / – / 0.63 / 0.52 s | 0.12–0.17 | Telugu exact; Tenglish 21 %; Telugu-script Tenglish 2 % |
| Piper runtime · `te_IN-padmavathi-medium` | 64 MB | 242 MB | 0.41 / – / 0.37 / 0.43 s | 0.11–0.13 | Telugu exact; Tenglish 25 %; Telugu-script Tenglish 8 % |
| Piper runtime · `en_US-joe-medium` | 63 MB | 227 MB ⁵ | – / 0.54 / – / – s | 0.18 | English exact |
| sherpa-onnx · `te_IN-venkatesh-medium` | 64 MB | 210 MB | 0.37 / – / 0.35 / 0.36 s | 0.13–0.15 | Telugu exact; Tenglish 25 %; Telugu-script Tenglish 4 % |
| sherpa-onnx · `te_IN-maya-medium` | 63 MB | 232 MB | 0.43 / – / 0.74 / 1.02 s | 0.16–0.31 | Telugu exact; Tenglish 15 %; Telugu-script Tenglish 2 % |
| sherpa-onnx · `te_IN-padmavathi-medium` | 64 MB | 230 MB | 0.76 / – / 0.59 / 0.54 s | 0.16–0.26 | Telugu exact; Tenglish 21 %; Telugu-script Tenglish 4 % |
| sherpa-onnx · `en_US-joe-medium` | 63 MB | 227 MB ⁵ | – / 0.45 / – / – s | 0.17 | English exact |
| sherpa-onnx · venkatesh + joe, split by script (**what HALO does today**) | 127 MB | 340 MB | 0.64 / 0.62 / 0.10 first, 0.51 whole / 0.48 s | 0.16–0.25 | Telugu 3 %; English exact; Tenglish not checkable ⁶ |
| sherpa-onnx · KittenTTS nano int8 | 28 MB | 363 MB | – / 3.8 / – / – s | 1.01 | English exact; English only |

⁴ Machine check only: each sample was fed to the best local recognizer for its
language (candidate #1 for Telugu and Tenglish, stock Whisper base for
English) and the character error rate recorded. It shows the words are
recoverable by a machine. **It says nothing about naturalness, accent or
pleasantness.**
⁵ Phase B figure for English text only. In this run the English voice was also
fed the Telugu sentences, which it reads out as 17–30 s of letter names; that
pushed its peak to 815–830 MB and is not a normal load.
⁶ The local recognizers are single-language, so the English half of a
two-voice sentence could not be checked. Phase B's round trip through Sarvam
is the evidence for that mode.

### What the numbers do and do not say

| Question | Answer |
| --- | --- |
| Is the output intelligible? | To a recognizer, yes: all three Telugu voices in both runtimes returned the Telugu sentence exactly, and the English voice returned the English sentence exactly. To a person: **not verified.** |
| Telugu pronunciation | **Not judged — needs listening.** One flag: six of the nine `venkatesh` clips were heard as `నీకు` rather than `మీకు`, and none of the twelve from the other two voices. That is either a recognizer slip or an m/n problem in the voice, and `నీకు` is the informal "you". Listen to this one first. |
| English pronunciation | **Not judged.** `joe` is an American voice, not Indian English. English text through a Telugu voice is poor even for a machine (14–78 % errors). |
| Tenglish pronunciation | A Telugu voice given Latin-script words garbles them (`solar panel price` heard as `సోలో పనులు పైస్`). Two ways around it: split by script into two voices (today's behaviour), or write the English words in Telugu script and keep one voice (2–8 % machine errors). **Which sounds better needs listening.** |
| Voice consistency | One voice per sentence in every row except the split row, where the speaker changes mid-sentence from a Telugu male voice to an American male voice. |
| Piper runtime vs sherpa-onnx | Same voice files, same audio content. The Piper runtime was slightly steadier (0.35–0.63 s) than sherpa-onnx (0.35–1.0 s) under this load. The Piper runtime normalizes output to full scale; sherpa-onnx output peaks at 0.3–0.7. |

### Samples to listen to

Saved under `models/local-speech-benchmark/` (git-ignored, 5.5 MB):

```
models/local-speech-benchmark/
  corpus/            the nine STT clips + corpus.json
  tts-samples/<candidate>/{te,en,mix,mix-translit}.wav
  results/           raw per-clip JSON for every candidate, score.txt
  scripts/           the benchmark scripts
```

The comparisons worth five minutes of a Telugu speaker's time:

1. `tts-samples/sherpa-piper-te_IN-venkatesh-medium/te.wav` against the `maya`
   and `padmavathi` folders — which Telugu voice, and is `మీకు` said correctly?
2. `tts-samples/sherpa-split/mix.wav` (two voices) against
   `tts-samples/sherpa-piper-te_IN-maya-medium/mix-translit.wav` (one voice,
   English words in Telugu script).
3. `tts-samples/sherpa-piper-en_US-joe-medium/en.wav` — acceptable for Indian
   callers?

## Ranking

### STT

1. **whisper.cpp + `whisper-telugu-base` (q5_1), `audio_ctx` sized to the
   utterance.** Best Telugu and Tenglish by a wide margin, correct script,
   digits intact, 60 MB, 170 MB RAM, about 1 s. Telugu-only.
2. **sherpa-onnx Omnilingual 300M CTC int8 (current).** The only single model
   that does Telugu, Tenglish and English at all, and the only one already
   integrated. Telugu is the problem that started this benchmark.
3. **whisper.cpp + `whisper-telugu-small` (q5_1).** Right script, but no more
   accurate than base here and 6–11 s per utterance.

For English-language sessions next to #1: **stock Whisper base q5_1 in the same
whisper.cpp runtime** (0–14 % corpus WER, 21–25 % on human read speech, 1.2 s
at ctx 768, another 60 MB).

### TTS

1. **sherpa-onnx TTS running the Piper voices** (`te_IN-venkatesh-medium` +
   `en_US-joe-medium`) — the current setup.
2. **Piper runtime with the same voices.**

This ranking is on integration and licence, **not on sound**: both runtimes
play the same voice models. sherpa-onnx is already integrated and is
Apache-2.0 (its bundled espeak-ng data is GPL-3.0); `piper-tts` 1.8.0 is
GPL-3.0 as a whole. Which Telugu voice is best is open until someone listens.

### Rejected candidates

| Candidate | Quality | Latency | Memory | Licence | Language limit |
| --- | --- | --- | --- | --- | --- |
| whisper.cpp Telugu Whisper small | No better than base; worse on human Telugu | **6–11 s** | fine (390 MB) | Apache-2.0 | Telugu-only |
| sherpa-onnx Dolphin base / small | **Telugu CER 63–73 %** on the corpus, empty outputs, mixed scripts | fast (0.1–0.3 s) | fine | Apache-2.0 | No usable English |
| whisper.cpp stock Whisper tiny / base | **Telugu unusable**, wrong script | 0.7–3 s | fine | MIT | Fine for English only |
| whisper.cpp stock Whisper small | Telugu unusable, loops; English very good | **10 s** | fine (386 MB) | MIT | – |
| sherpa-onnx stock Whisper base | Same Telugu failure as whisper.cpp | 1.0 s | 437–815 MB | MIT | – |
| sherpa-onnx `whisper-tiny-te` (ippocode) | **Empty text on every clip** in sherpa-onnx 1.13.8 (tokens outside its table) | – | – | Apache-2.0 | – |
| KittenTTS nano (TTS) | Intelligible English | **3.8 s, slower than real time** | 363 MB | Apache-2.0 | English only |
| Piper runtime (TTS) | Same audio as sherpa-onnx | same | same | **GPL-3.0** runtime | – |

### Candidates not tested

| Candidate | Why |
| --- | --- |
| **Laya AI** | No speech model could be identified. The only "Laya" models found on Hugging Face are text-classification models, not ASR. Not installed, as instructed. |
| sherpa-onnx Omnilingual **1B** CTC int8 | 787 MB download, about 1 GB on disk, and by the 300M model's footprint (634 MB) would need more RAM than was free (1.5–2.6 GB). Over the stated budget. The most likely remaining accuracy gain within sherpa-onnx; worth a run on a larger host. |
| whisper.cpp `whisper-telugu-medium` q5 (539 MB) | The small model already takes 6–11 s; medium is about three times the compute. |
| sherpa-onnx Whisper small / turbo / medium / large | 0.56–1.9 GB, and stock Whisper failed Telugu at every size tested. |
| wav2vec2 Telugu models (Vakyansh, IndicWav2Vec, XLS-R fine-tunes) | No ready sherpa-onnx or whisper.cpp build; would need a PyTorch export — guesswork. |
| Qwen3-ASR, FunASR-nano, SenseVoice, Parakeet, Canary (sherpa-onnx) | Not known to cover Telugu; not checked further. |
| Other sherpa-onnx TTS families (Kokoro, Matcha, Supertonic, ZipVoice, Pocket) | sherpa-onnx's published TTS model list has no Telugu voice. MMS TTS is CC-BY-NC and has no Telugu pack there. |
| IndicConformer, IndicF5, Voicebox, Ollama | Excluded by the task. |

## Recommendation

**BEST LOCAL STT:** whisper.cpp + `vasista22/whisper-telugu-base` (ggml q5_1,
from `ukta-app/indic-whisper-ggml`), with `no_timestamps`, `single_segment`,
no temperature fallback, and `audio_ctx` = max(512, utterance length); stock
Whisper base q5_1 in the same runtime for English sessions.

**BEST LOCAL TTS:** Piper voices `te_IN-venkatesh-medium` + `en_US-joe-medium`
through sherpa-onnx — unchanged, and provisional until a person listens.

**BEST LOCAL COMBINATION:** whisper.cpp Telugu Whisper base (+ stock Whisper
base for English) + sherpa-onnx Piper voices. About 270 MB on disk and
roughly 0.7 GB of RAM with everything loaded — smaller than today's 0.55 GB /
1.2 GB local setup.

The stop condition does **not** apply: one candidate gives usable Telugu on
this hardware. "Usable" here means good enough to be a fallback that keeps a
call going, on the evidence above.

**Is Telugu production-usable locally? No.**

- About 28–30 % word errors and 11 % character errors on human Telugu, against
  Sarvam's 6 % and 2 %.
- 1.0–1.7 s after the caller stops, against Sarvam's 0.2 s, with all four
  cores busy; no interim results, no confidence score.
- One of seven receptionist clips came back with its meaning changed.
- Evidence is 13 synthetic Telugu and Tenglish clips and 8 human Telugu
  clips, with no real caller and no native review.

**Keep Sarvam as primary.** Local speech remains fallback and development
infrastructure.

**Can Phase B be declared COMPLETE? Not yet.**

- The infrastructure is built and working (Phase B).
- But the local STT model HALO actually ships is the one judged not acceptable
  for Telugu, and the model that fixes most of that is not integrated.
- No one has listened to the local TTS.

What would close it, in order:

1. A human listens to the saved TTS samples and picks a Telugu voice and a
   Tenglish approach.
2. Decide whether to adopt the Telugu Whisper model. It needs a new STT
   provider behind the existing interface, and three things settled first:
   - **Runtime.** whisper.cpp is a second speech runtime (the worker can use
     `pywhispercpp`; the gateway would need a Node binding). Exporting the
     same model to sherpa-onnx would keep one runtime, but the one published
     sherpa-onnx Telugu Whisper pack tried here did not work.
   - **Language routing.** The model is Telugu-only, so an English session
     needs the second model, and a caller who switches language mid-call is
     not handled. Today's single Omnilingual model does not have this problem.
   - **Long utterances and silence** have to be tested before a live call.
3. Re-run the Phase B browser voice path with the new model for a real
   end-to-end turn time.

## Licences of the recommended pieces

| Piece | Licence |
| --- | --- |
| `vasista22/whisper-telugu-base` (Speech Lab, IIT Madras) | Apache-2.0; base weights OpenAI Whisper, MIT |
| `ukta-app/indic-whisper-ggml` (the ggml q5_1 conversion used) | Apache-2.0; a third-party conversion — convert from the source model before shipping |
| whisper.cpp, `pywhispercpp` | MIT |
| Stock Whisper base | MIT |
| Piper voices, sherpa-onnx, espeak-ng data | As in `docs/LOCAL_SPEECH.md` (CC-BY-4.0 / CC0 voices, Apache-2.0 runtime, GPL-3.0 espeak-ng) |

## Phase B finalization audit (2026-10-09)

This section supersedes the original shootout recommendation above where it
describes the Telugu Whisper base candidate as an acceptable fallback. The
measurements are evidence to evaluate that candidate, not production
acceptance.

### Verdict

**PHASE B NOT COMPLETE.** The local fallback path is implemented and the
selected local models run, but the selected Omnilingual model has poor Telugu
quality, and no person has listened to the TTS candidates. The Telugu-only
Whisper base candidate remains experimental: the benchmark found materially
better Telugu transcription than Omnilingual, but 28–30% WER on only eight
human read-speech clips, 1.0–2.2 seconds decode on short clips, no English
recognition, Tenglish errors including a meaning-changing receptionist turn,
and no validation on callers. Those results do not justify making it an
automatic outage fallback on this machine.

### Current tree and model availability

The uncommitted working tree already contains gateway and Pipecat local STT /
TTS adapters, explicit provider selection, fallback wrappers, and focused
tests. The `models/voice-local/` directory is present (610 MB on disk):
Omnilingual CTC int8, `te_IN-venkatesh-medium`, `en_US-joe-medium`, and bundled
eSpeak NG data. The 5.5 MB benchmark sample directory is also present. No
Telugu Whisper GGML/`.gguf` model was found under `models/`; it was not
downloaded. At inspection, the filesystem had 887 GiB free, system RAM was
4.8 GiB total with 1.8 GiB available, and the environment reported 8 logical
CPUs. Inference below used four threads to match the benchmark configuration.

### Reproduction on the current checkout

`/usr/bin/time -v ./.venv/bin/python scripts/check-local-speech-inference.py`
loaded the current manifest models and ran three saved corpus clips plus one
Telugu and one English TTS sentence. This was real local model inference,
with no provider service, browser, or live call:

| Operation | Input / output | Decode or synthesis | Process peak RSS |
| --- | --- | ---: | ---: |
| Omnilingual STT | 3.71 s Telugu (`te-1.wav`) | 2.010 s | |
| Omnilingual STT | 2.48 s English (`en-7.wav`) | 1.107 s | |
| Omnilingual STT | 1.79 s Tenglish (`mix-4.wav`) | 0.761 s | |
| Piper Telugu TTS through sherpa-onnx | 2.37 s generated audio | 0.467 s | |
| Piper English TTS through sherpa-onnx | 2.64 s generated audio | 0.851 s | |
| Whole process (models loaded sequentially) | | 31.79 s elapsed | 702,256 KiB |

The run overlapped other test and lint processes, so the decode times are a
loaded-host spot check. This is not a quality rerun or a latency distribution.
The Telugu and English snippets look plausible in text but the Tenglish
transcript contained several wrong-script substitutions; these examples do
not change the corpus verdict. Resource figures are for this one process and
do not estimate concurrent-call load.

### Provider and recovery review

- The gateway reads `VOICE_STT_PROVIDER` / `VOICE_TTS_PROVIDER` and their
  `_FALLBACK_PROVIDER` counterparts. The worker uses those same names, then
  `HALO_SPEECH_PROVIDER`, then Sarvam as its default. Tenant profiles override
  environment selection. Gateway validation checks credentials and model-dir
  requirements for both primary and fallback. Local selection needs no
  speech-provider credential.
- The gateway wrappers switch only on explicitly recoverable provider
  failures before any final transcript / audio. The worker's Pipecat
  `ServiceSwitcher` switches once for a recoverable error and does not replay
  the failed utterance or speech line. Controlled fake tests cover these
  decisions; no real Sarvam outage was induced.
- Sarvam remains selectable with its existing model, key, mode, and voice
  settings. Configuration and adapter regression tests cover the Sarvam-only
  path. This audit did not make a live Sarvam request.
- The current gateway STT provider used to decode only a rolling tail after a
  30-second utterance. It now emits a non-recoverable `too_long` error and
  discards that utterance, matching the worker's existing overlong-segment
  behavior. It never returns a transcript for a silently truncated request.

### Evidence level

| Level | This audit |
| --- | --- |
| Unit/fake | 39 Vitest tests passed (5 skipped); 54 Pipecat worker tests passed (1 skipped), including the local WebSocket worker test with fake STT/TTS |
| Real model inference | Yes, spot check above using existing models |
| Real running services | No new service session in this audit |
| Real browser playback | Not repeated in this audit; the earlier browser run remains the dated evidence in `docs/LOCAL_SPEECH.md` |
| Human listening | No; use the playlist runbook in `docs/LOCAL_SPEECH.md` and report the voice/Tenglish assessment |

Additional checks passed: `npm run typecheck`, `npm run lint`,
`npm run check:architecture`, and `npm run preflight:ci` (the latter skipped
database connectivity by design). The first sandboxed preflight and worker
WebSocket attempt were denied local socket creation; both passed after rerun
with approved local socket access. `git diff --check` also passed.

The earlier browser-path figures in `docs/LOCAL_SPEECH.md` used recorded audio
injection in headless Chromium, not a physical microphone. They are not a
live-microphone result and were not reproduced on 2026-10-09.

### License source check

The [sherpa-onnx upstream license](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE)
is Apache-2.0, and Meta states the [Omnilingual ASR code and models](https://github.com/facebookresearch/omnilingual-asr#license)
are Apache-2.0. The selected [Telugu Venkatesh Piper model card](https://huggingface.co/rhasspy/piper-voices/blob/main/te/te_IN/venkatesh/medium/MODEL_CARD)
identifies IndicVoices-R under CC-BY-4.0; the [English Joe model card](https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/joe/medium/MODEL_CARD)
identifies CC0 training data. These are dataset/model-artifact facts, distinct
from runtime licensing. The bundled [eSpeak NG project](https://github.com/espeak-ng/espeak-ng)
is GPL-3.0-or-later. Flag the bundled phonemizer data/runtime for distribution
review; this report is not a legal determination. The experimental Telugu
Whisper base weights declare Apache-2.0 on their [model card](https://huggingface.co/vasista22/whisper-telugu-base),
while [whisper.cpp](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE)
is MIT. The tested third-party quantized conversion is not present here and
would require its own artifact/provenance check before redistribution.

### Smallest next actions

1. A Telugu speaker auditions `scripts/play-local-speech-samples.ps1` and
   reports the best Telugu voice, acceptable Tenglish treatment, and English
   voice assessment.
2. If the product goal requires a real local Telugu outage fallback, decide
   whether to accept the measured quality and delay for a Telugu-only
   experimental provider. That requires explicit language-scoped routing,
   Tenglish exclusion, a safe utterance-duration policy, timeout handling,
   and browser-path latency evidence before production selection.
3. If those constraints are not acceptable, keep Sarvam as the known-good
   Telugu provider and Phase B open until a suitable local model or target
   hardware is available.

## Phase B.3 — Telugu candidate evidence review (2026-10-09)

This is a review of the Phase B.2 raw outputs and local artifacts, not a new
inference run. It supersedes the earlier recommendation that called the
Telugu Whisper model a usable local fallback: the accuracy gain is real on
these clips, but there is not enough target-domain evidence to recommend
integration yet.

### Direct comparison with the current baseline

The comparison below uses the same 8 kHz audio, references, normalization,
and `score.py` implementation for `whisper-telugu-base` q5_1 at `audio_ctx`
512 and sherpa-onnx Omnilingual 300M CTC int8. Corpus speech is synthetic
Sarvam TTS; FLEURS is human read speech. Figures are recovered from
`results/summary.json`, `results/stt-wcpp-te-base-q5_1_ctx512.json`, and
`results/stt-sherpa-omni-300m.json`.

| Category (8 kHz) | Telugu Whisper base: WER / CER | Omnilingual 300M: WER / CER | Notes |
| --- | ---: | ---: | --- |
| Telugu synthetic corpus (3 clips) | 22% / 4% | 61% / 17% | Candidate wrote Telugu script on all clips. |
| Telugu human FLEURS (8 clips) | 30% / 11% | 78% / 24% | Candidate wrote Telugu script on all 8; Omnilingual mixed other scripts. |
| Tenglish synthetic corpus (3 clips) | 33% / 10% | 73% / 23% | Candidate transliterated English words into Telugu; Latin spellings were not preserved. |
| English synthetic corpus (3 clips) | 100% / 93% | 33% / 15% | Telugu-only candidate returned Telugu script. |
| English human FLEURS (8 clips) | 100% / 94% | 23% / 10% | Same language limitation on human English. |
| Spoken phone number (1 synthetic clip) | 1% CER | 67% CER | Candidate preserved all ten spoken number words, but output them as words rather than digit-formatted text. |

The phone-number example is a single synthetic clip, not evidence that phone
numbers are safe to collect. On the seven synthetic receptionist Telugu and
Tenglish clips, the candidate also changed “cancel” to “cancer” and dropped
“reschedule” on one request (26% CER); the baseline scored 10% CER on that
request. This is a meaning-changing error.

The same raw run reports a 60 MB q5_1 model, 170 MB peak process RSS, 1.18 s
decode p50, 2.22 s maximum, and 0.41 mean real-time factor. The baseline is
366 MB, 634 MB peak RSS, 1.55 s p50, 3.08 s maximum, and 0.44 mean RTF.
Both used four threads on the Intel i5-8265U, with a Telugu (`te`) language
hint. The candidate used `no_timestamps=true`, `single_segment=true`,
`temperature_inc=0.0`, and `audio_ctx=512` (10.24 seconds of encoder context).
Longer utterances need a correspondingly larger context or risk truncation.
These are offline decode times after the audio endpoint, not streaming
response times. They were measured while the development stack was busy, as
noted in Phase B.2. The candidate is therefore feasible by the recorded CPU
and memory measurements, but it is Telugu-only and does not replace the
baseline for English.

### Local artifact and runtime check

The benchmark audio, references, per-clip JSON and scoring scripts remain in
`models/local-speech-benchmark/`. The current Omnilingual model and tokens
remain in `models/voice-local/stt/`. No `ggml-te-base.bin` or other
`whisper-telugu-base` weights were found in the repository model folders,
`/home/parzifal/.cache/huggingface/hub`, `/home/parzifal/.cache/whisper`, or
the searched `/tmp` model paths. The benchmark result JSON records the
candidate and settings, but not a model checksum. Thus those outputs are
recoverable evidence, while a fresh candidate inference is not reproducible
from the current local files alone.

The recorded runtime was whisper.cpp 1.8.5 through pywhispercpp 1.5.1; this
CPU path did run on this machine in Phase B.2. Four threads were used. The
current host check reports 4.8 GiB total memory, about 3.4 GiB available at
inspection, 898 GiB free disk, and no GPU. The candidate's previously measured
170 MB RSS and 60 MB quantized size are within that envelope. No model was
downloaded and no benchmark was rerun for this review.

### License inventory

- **Telugu weights and quantized artifact:** the
  [`vasista22/whisper-telugu-base` model card](https://huggingface.co/vasista22/whisper-telugu-base)
  declares Apache-2.0. The
  [`ukta-app/indic-whisper-ggml` card](https://huggingface.co/ukta-app/indic-whisper-ggml)
  declares Apache-2.0 for its converted/quantized derivatives, and identifies
  the OpenAI Whisper base weights as MIT. Its current card describes q5_1
  small builds; the exact 60 MB base artifact used in Phase B.2 is absent
  locally and has no recorded checksum, so its exact revision was not
  independently checked.
- **Inference runtime and Python binding:** whisper.cpp and pywhispercpp
  declare MIT. The benchmark used pywhispercpp 1.5.1.
- **Tokenizer and conversion:** the ggml artifact carries the tokenizer data
  needed by whisper.cpp; no separate tokenizer license was identified. The
  conversion is described as format conversion plus q5_1 quantization.
- **Training data:** the Telugu model card lists several corpora, and the ggml
  card mentions AI4Bharat data and FLEURS/CC-BY. Their individual terms and
  any downstream obligations were not audited here. Commercial-use questions
  about the full training-data lineage and redistribution of the exact
  quantized artifact remain open; these license labels are not a legal
  conclusion.
- **Current baseline:** Meta's Omnilingual model card declares Apache-2.0 for
  the weights; sherpa-onnx runtime declares Apache-2.0. Its token file ships
  with the model pack. The model pack's provenance and license should continue
  to be checked if it is redistributed.

### Scoring and reproduction

The scorer NFC-normalizes, lowercases, removes punctuation, strips Telugu
joiners, and collapses whitespace before separate jiwer WER and CER scoring.
For Tenglish it selects the lower-CER reference (the original Latin form or
the Telugu-script rendering), then computes WER and CER against that selected
reference. The nine corpus clips are synthetic; human Telugu and English are
eight FLEURS clips each. There are no human-read Tenglish clips. Spoken digits
are represented by only the one synthetic Telugu phone-number example above.

Re-score the preserved per-clip outputs without touching repository artifacts:

```bash
mkdir -p /tmp/halo-local-stt-rescore
cp models/local-speech-benchmark/results/stt-wcpp-te-base-q5_1_ctx512.json /tmp/halo-local-stt-rescore/stt-te-base.json
cp models/local-speech-benchmark/results/stt-sherpa-omni-300m.json /tmp/halo-local-stt-rescore/stt-omni.json
python3 models/local-speech-benchmark/scripts/score.py /tmp/halo-local-stt-rescore
```

The recorded Phase B.2 inference invocation was equivalent to:

```bash
BENCH_S=<benchmark-workspace> BENCH_P=<phase-b-workspace> \
  <phase-b-python> models/local-speech-benchmark/scripts/stt_bench.py \
  'wcpp-te-base-q5_1@ctx512' /tmp/te-base-ctx512.json 4
```

It requires `BENCH_S/dl/ggml-te-base.bin`, the corpus clips/references, and
the Phase B environment. Those exact model files are not present now, so this
inference command cannot currently reproduce the candidate measurements.
Omnilingual's matching output is already in
`results/stt-sherpa-omni-300m.json`; `scripts/check-local-speech-inference.py`
is a targeted smoke check for the installed baseline, not a re-score of the
Whisper candidate.

### Recommendation

**Further evaluation.** The Whisper fine-tune is a meaningful Telugu
recognition improvement on this small benchmark and is light enough for this
machine. However, it loses ordinary English, does not preserve Latin-script
English words in Tenglish, made a meaning-changing cancellation error, and
has only eight human Telugu clips with no native-speaker transcript review.
The exact q5_1 base artifact is also missing locally and the prior run has no
artifact checksum. Keep Sarvam unchanged and do not integrate this candidate
from this evidence. The next single action is to have a Telugu speaker review
the existing human Telugu and receptionist transcripts, with extra attention
to phone-number and cancellation utterances; then decide whether to recover a
checksum-pinned candidate artifact for a repeat run.

## Phase B.4 — recovered-artifact check and engineering follow-up (2026-10-14)

The checkout contains `models/local-speech-benchmark/corpus/corpus.json`, the
nine referenced WAVs (all explicitly `Sarvam TTS (synthetic)`), TTS WAVs,
`results/score.txt`, `results/summary.json`, and the per-candidate raw result
JSON. It does **not** contain the FLEURS `fleurs.json` clip manifest or any of
the 16 FLEURS WAVs. The eight Telugu references and stored hypotheses remain
in the raw JSON, but the local rows identify only `fleurs-te-0` … `fleurs-te-7`
and have no source dataset IDs or audio checksums. The recorded benchmark
scratchpad paths are no longer present. A read-only public metadata recovery
request timed out without data; no model or dataset was downloaded. There was
no expected checksum list for the available corpus WAVs to verify against.

The current manifest-pinned local STT model was freshly run against all nine
available synthetic clips using four threads, once after normal 16 kHz
resampling and once after an 8 kHz wire-band round trip. See
`scripts/evaluate-local-synthetic-corpus.py` and
`docs/LOCAL_TELUGU_STT_HUMAN_REVIEW.md` for per-clip output and metrics. This
does not reproduce any FLEURS score and gives no evidence of human acceptance.
The exact model is
`sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-v2-int8-2026-02-05`, as
recorded in `models/voice-local/manifest.json`. The previous
`vasista22/whisper-telugu-base` q5_1 inference remains historical; its model
artifact and expected checksum are absent.

Local Venkatesh Telugu and Joe English TTS listening files covering short and
long utterances, names, dates, times, digit read-back, booking language, and a
Telugu/English switch were generated from the already-installed manifest
models. Exact text, paths, consented recording instructions, and scoring
criteria are in `docs/LOCAL_TELUGU_HUMAN_REVIEW_PACKET.md`. Human STT and TTS
review remains pending.

The booking system now reads back the selected offered date/time and waits for
a clear yes before calling the booking port. A rejection, ambiguous answer,
or unconfirmed selection cannot finalize a booking. Arunodhaya's phone field
already requires read-back via `confirm: true`, including when confidence is
null; this change adds no tenant-schema or broad policy edits. Sarvam remains
the primary provider and no new model was selected.

## Phase B.5 — Venkatesh vs Padmavathi and the local TTS text pipeline (2026-10-14)

**Scope:** isolated benchmark plus a text-pipeline fix in both local TTS
implementations. Production models, `models/voice-local/manifest.json` and
provider routing are unchanged; Sarvam stays primary. **No human has listened
to any of this audio**, and every intelligibility number below comes from a
machine recognizer, not from a person.

### Padmavathi model: source, licence, checksums

| | |
| --- | --- |
| Source | `rhasspy/piper-voices`, pinned revision `c10ece1aade47bb51c153c893d14e5bf8e5b7117`, path `te/te_IN/padmavathi/medium/` |
| Repository licence (HF card) | MIT |
| Voice `MODEL_CARD` | 1 speaker, 22,050 Hz, medium; dataset `ai4bharat/indicvoices_r`, **CC-BY-4.0**; trained by `github.com/PravalX` (third party). CC-BY attribution applies before any shipped use; not a legal review. |
| `te_IN-padmavathi-medium.onnx` | 63,516,050 B, SHA-256 `414aa5960d91ceb6e45bbdf8c27fdc71af09f205130d7be4e99470f3c2cfa57d` (= HF LFS oid), md5 `1a7fb140ecc8b5e8b3e80e460b719319` (= repo `voices.json`) |
| `te_IN-padmavathi-medium.onnx.json` | SHA-256 `6c86e4ee99d379815f78a75f23cdad62ccf50370062dd915c233d6e22de7109f`, md5 `3f07441340aecc2a8b89987361e8078e` (= `voices.json`), git blob `5afaa8ee…` (= HF tree) |
| `MODEL_CARD` | SHA-256 `8cdccd0ca4c26d1e949431f03180bcf9eaeb3c013f627087c6a806a3f7487b07`, md5 = `voices.json` |
| sherpa-onnx conversion | `setup_local_speech.convert_piper_voice` (extracted from `provision_voice`, byte-identical: re-converting Venkatesh reproduces the installed `f84931d2…`) → `model.onnx` SHA-256 `104d1d0b1d88bd243b3543a208bd98405c69e3d77f05a18055359ce867a5649b` |
| Stored at | `models/local-speech-benchmark/voices/te_IN-padmavathi-medium/` (git-ignored); `onnx.checker` passes |

The installed Venkatesh download also matches `voices.json` (md5
`145092d2…`). The benchmark refuses to run on any checksum mismatch.
Indic Parler-TTS remains deferred: not downloaded, no dependency added.

### What was run

Twenty-eight synthetic lines in `scripts/local-tts-benchmark-phrases.json`
(no customer data): మీకు/నీకు minimal pairs, పది/పదకొండు, phone
digits (bare, `+91` grouped, pre-spelled, English), numeric and Telugu-month
dates, times (colon, AM/PM, range, English), prices (lakh grouping, `Rs.`,
percent), Telugu and mixed names, booking confirmation, cancellation, and
Telugu-English code-switching including a suffix glued to an English word.
Each Telugu voice is paired with the installed `en_US-joe-medium` for Latin
runs, exactly as production pairs Venkatesh.

```sh
.venv/bin/python -I scripts/benchmark-local-tts.py --label legacy  --pipeline legacy  --stt   # pre-change pipeline, 3 repeats
.venv/bin/python -I scripts/benchmark-local-tts.py --label current --pipeline current --stt   # new pipeline, 3 repeats
.venv/bin/python -I scripts/benchmark-local-tts.py --label <l> --pipeline legacy --rescore     # re-score stored hypotheses
```

sherpa-onnx 1.13.8, 4 threads, `max_num_sentences=1`, speed 1.0, i5-8265U
(WSL2, 4.8 GB). Latency is the median of 3 synthesis repeats after a warm-up;
"first audio" is the end of the first segment's synthesis, which is when the
worker releases it.
Audio: `models/local-speech-benchmark/tts-te-voices/<label>/<voice>/<phrase>.wav`
(22,050 Hz mono PCM16) with `results.json` holding the command, checksums,
config, per-segment text and timing, join metrics and every hypothesis.

**Machine round trip.** Each WAV went through the *installed* local recognizer
(sherpa-onnx Omnilingual 300M CTC int8) at 16 kHz and after an 8 kHz
wire-band round trip. That recognizer is weak on Telugu (it sometimes answers
in Kannada, Tamil or Malayalam script and writes spoken digits as numerals),
so its scores are a **relative signal between variants on identical text**,
not intelligibility to a listener. Scoring: NFC, lowercase, punctuation and
ZWJ/ZWNJ removed; numerals in a hypothesis count as the spoken digit word of
the phrase's language; CER against the closer of the Latin and Telugu-script
references; "critical" = booking-critical tokens found in spoken order (LCS),
119 per voice per band.

**Synthesis failures:** none, for either voice, in any of the 13 runs
(28/28 lines × 2 voices each).

### Results: legacy vs new pipeline (critical tokens found / CER)

| Category | Venkatesh legacy 16k · 8k | Venkatesh new 16k · 8k | Padmavathi legacy 16k · 8k | Padmavathi new 16k · 8k |
| --- | --- | --- | --- | --- |
| Phone (42 tokens) | 19 · 15 / 43 % · 42 % | 28 · 31 / 17 % · 10 % | 16 · 16 / 43 % · 46 % | 23 · 26 / 18 % · 16 % |
| Time (13) | 1 · 2 / 50 % · 44 % | 9 · 8 / 18 % · 23 % | 4 · 4 / 43 % · 44 % | 11 · 10 / 10 % · 13 % |
| Date (6) | 1 · 1 / 78 % · 64 % | 2 · 3 / 28 % · 27 % | 1 · 1 / 65 % · 64 % | 2 · 2 / 48 % · 34 % |
| Price (13) | 3 · 2 / 28 % · 28 % | 4 · 4 / 20 % · 19 % | 4 · 3 / 25 % · 27 % | 7 · 7 / 17 % · 11 % |
| Booking (10) | 3 · 3 / 46 % · 41 % | 4 · 4 / 17 % · 18 % | 4 · 2 / 46 % · 46 % | 5 · 4 / 18 % · 22 % |
| Cancellation (5) | 2 · 2 / 48 % · 40 % | 2 · 2 / 22 % · 22 % | 3 · 2 / 41 % · 40 % | 2 · 2 / 19 % · 19 % |
| Minimal contrast (9) | 7 · 6 / 7 % · 8 % | 8 · 8 / 10 % · 7 % | 9 · 9 / 2 % · 3 % | 7 · 8 / 8 % · 4 % |
| Names (6) | 1 · 1 / 18 % · 18 % | 1 · 1 / 28 % · 29 % | 1 · 2 / 15 % · 27 % | 1 · 0 / 17 % · 32 % |
| Code-switch (13) | 4 · 4 / 26 % · 24 % | 5 · 5 / 29 % · 25 % | 5 · 5 / 24 % · 23 % | 5 · 5 / 26 % · 21 % |
| **All (119)** | **43 · 38 / 37 % · 34 %** | **65 · 68 / 20 % · 19 %** | **49 · 46 / 34 % · 36 %** | **65 · 66 / 19 % · 18 %** |

What the legacy rows show, in the recognizer's own words: Padmavathi's
`9876543210` came back as `తొమ్మిది వందల ఎనభై ఏడు కోట్ల…` (one cardinal in
crores, 4.7–5.4 s of audio); `24/03/2026` as `ఇరవైనాలుగు కుదిరాలు గీత…` (the
slash read as a word); `Dr. Rao at 10:30 AM, Rs. 45,000` was split by
sherpa-onnx into three "sentences" at the abbreviation dots; `10:30` and
`5 PM` were lost.

Read the small categories with care. The minimal-contrast and name lines have
**identical text** in both pipelines; only the edge trim and pauses differ,
so their movement (e.g. Padmavathi `పది` heard as `1ది` in one band) is
recognizer noise. **మీకు/నీకు (c01–c04) was recognized correctly in every
clip, both voices, both pipelines, both bands** — this recognizer does not
reproduce the Phase B.2 flag (Venkatesh heard as `నీకు` by the Whisper
fine-tune), so that flag is neither confirmed nor cleared. Names score 0–2/6
in every run because the strict token match rejects `శ్రీలక్ష్మీ` (long ī)
and `రెడ్డిగారికి` (joined); the English voice still says `Ravi Kumar` as an
American would.

**Venkatesh vs Padmavathi.** On identical lines and this recognizer the two
are indistinguishable after the fix (65/119 each at 16 kHz). Before it,
Padmavathi scored higher (49 vs 43), mostly on the minimal pairs and names.
Padmavathi is slower to first audio on long lines (phone lines 704 ms vs
644 ms median) and produces 16 % more audio for the same text (133 s vs
115 s), i.e. speaks more slowly. **Padmavathi is female and is paired with
the male American `joe` voice for English words**, so every code-switched
line changes gender mid-sentence; no female English voice was downloaded.
Choosing between the voices is a listening decision; nothing here supports
replacing Venkatesh.

### Latency (median of 3 repeats; warm models)

| | First audio, all lines | Max | Phone lines | Booking lines | Code-switch lines | RTF |
| --- | --- | --- | --- | --- | --- | --- |
| Venkatesh legacy | 296 ms | 758 ms | 680 ms | 652 ms | 55 ms | 0.12 |
| Venkatesh new | 312 ms | 836 ms | 644 ms | 380 ms | 69 ms | 0.11 |
| Padmavathi legacy | 356 ms | 1,037 ms | 854 ms | 828 ms | 59 ms | 0.12 |
| Padmavathi new | 346 ms | 826 ms | 704 ms | 453 ms | 73 ms | 0.11 |

The new run started at load average 3.7 against 0.65 for the legacy run, so
small differences are not meaningful. Booking lines got faster because the
new pipeline synthesizes one sentence (or clause) per call, where the legacy
worker path synthesized a whole multi-sentence run before releasing any of it;
code-switch first audio is the first one-word Telugu run (`మీకు`).

### Text-pipeline fix (both implementations)

`services/pipecat-worker/local_tts_text.py` and
`packages/providers/voice-vendors/local-tts-text.ts` implement the same
pipeline and are pinned to each other by 55 shared cases in
`tests/fixtures/local-tts-text-cases.json` (run by
`tests/unit/voice/local-tts-text.test.ts` and
`services/pipecat-worker/test_local_tts_text.py`, written before any tuning).

- **Numbers in the language around them:** Telugu if the next word is
  Telugu, or the previous one is and the next is not English; English if
  either neighbour is English; otherwise the line's language. A line with
  no voice for its language still fails `unsupported_language`.
- **Phone numbers** (5–15 digits, `+cc`, spaces/hyphens) digit by digit,
  grouped as written (10 bare digits as 5 + 5) with a comma pause that is
  never a segment boundary. Leading-zero numbers digit by digit.
- **Dates** `DD/MM/YYYY`, ISO, `March 24`, `24th March` → Telugu
  `రెండు వేల ఇరవై ఆరు మార్చి ఇరవై నాలుగో తేదీ` (year first) or English
  `twenty fourth March, two thousand twenty six`. Day-first is assumed.
- **Times** with colon or AM/PM, ranges → `ఉదయం పది గంటల ముప్పై నిమిషాలు`
  (period word omitted when the line already says it; ఒంటి గంట for 1),
  `ten thirty ay em`; Telugu suffixes merge (`గంటలకు`, `గంటల తర్వాత`,
  `తేదీన`, `పదికి`, `మూడవ`).
- **Prices** `₹`, `Rs.`, `INR`, `/-`, lakh/crore grouping and scale words →
  `ఒక లక్ష నలభై ఐదు వేల రూపాయలు`, `one lakh eighty five thousand rupees`
  (Indian scale in English too); percent, decimals; attributive forms before
  a known noun (`ఒక రోజు`, `రెండు వేల మంది`).
- **Abbreviations and units:** `Dr. Mr. Mrs. Ms. No. Ltd. e.g. i.e. etc.
  approx. vs` and `డా.`; `kW kWh km hr(s) min(s) sq ft` after a number;
  2–3-letter capitals spelled (`GST` → `jee es tee`, `OK` → `okay`).
- **Segmentation:** one synthesis per sentence (abbreviation dots no longer
  end sentences); sentences over 60 characters at clause punctuation with a
  short tail merged back; then by script. Each segment carries the pause for
  how it ends.
- **Joining:** each segment's own edge silence is trimmed (−40 dBFS, 25 ms
  kept), edges faded 5 ms, then a pause inserted: 280 ms after a sentence,
  160 ms after a clause, 40 ms at a mid-phrase voice switch. Previously a
  switch left the two voices' own edge silence (40–190 ms each) in between.
  The gateway now releases audio a segment at a time (one sherpa callback
  per segment, as segments are single sentences).

Existing tests changed only where behaviour intentionally changed (audio
length now includes the pause; `10` reaches the voice as `పది`/`ten`).

### Tuning (one change at a time)

Same 28 lines, both voices, 1 repeat each, scored as above. VITS synthesis is
stochastic, so the unchanged configuration was run three times to measure the
noise floor. Pre-registered rule: adopt a change only if its critical-token
total (both voices, both bands, of 476) exceeds the floor's maximum plus its
spread and no voice/band falls below the floor's minimum.

| Variant (vs new defaults) | Total | Venkatesh 16k · 8k | Padmavathi 16k · 8k | Audio | Verdict |
| --- | ---: | --- | --- | ---: | --- |
| Defaults, run 1 / 2 / 3 | 264 / 266 / 261 | 60–65 · 62–68 | 65–67 · 66–72 | 249–250 s | noise floor, spread 5 |
| Voice-switch pause 20 ms | 275, repeat **260** | 66 · 67 / 65 · 61 | 72 · 70 / 67 · 67 | 249 s | not confirmed on repeat — rejected |
| Voice-switch pause 80 ms | 248 | 59 · 60 | 61 · 68 | 251 s | worse (single run) — rejected |
| Clause pause 240 ms | 267 | 63 · 66 | 67 · 71 | 250 s | within noise — kept 160 |
| Sentence pause 200 ms | 261 | **55** · 66 | 70 · 70 | 243 s | Venkatesh below floor — kept 280 |
| Telugu speed 0.9 | 261 | 59 · 64 | 67 · 71 | 258 s | within noise, slower — kept 1.0 |
| No fade (0 ms) | 272 | 71 · 68 | **63** · 70 | 250 s | Padmavathi below floor; fades guard joins — kept 5 ms |
| Keep 10 ms at trimmed edges | 264 | 62 · 62 | 67 · 73 | 247 s | within noise — kept 25 ms |

**No tuning change was adopted.** This recognizer cannot resolve pause or
rate changes of this size; naturalness of pauses, pace and voice switches is
a listening question.

### Sarvam STT round trip — estimate only, not run

Sarvam speech-to-text is ₹30 per audio hour, billed per second rounded up per
request ([pricing](https://docs.sarvam.ai/api/pricing.md), checked
2026-10-14). On the measured clip durations (each under 30 s):

| Option | Requests | Billed seconds | Estimate |
| --- | ---: | ---: | ---: |
| New pipeline only, both voices, 16 kHz | 56 | 280 | ₹2.33 |
| Legacy + new, 16 kHz | 112 | 552 | ₹4.60 |
| Legacy + new, 16 kHz + 8 kHz | 224 | 1,104 | ₹9.20 |

**Stopped.** The approved project budget (`POA` rule 1) is $0 incremental
spend and says to stop when cost is uncertain; free-credit balance could not
be confirmed. No Sarvam request was made and no audio left this machine. To
run it, an owner must approve the spend (or confirm a $0 credit balance); the
input would be synthetic benchmark WAVs only.

### Still required from people

1. A Telugu-fluent reviewer listens to `tts-te-voices/current/{venkatesh,padmavathi}/`
   (and `legacy/` for the same lines) and scores intelligibility,
   pronunciation, naturalness and pace per the
   [review packet](LOCAL_TELUGU_HUMAN_REVIEW_PACKET.md), first `c01`–`c04`
   (మీకు/నీకు) and `d01`–`d03` (digits).
2. The same reviewer checks the Telugu renderings themselves: year-first dates,
   `గంటల … నిమిషాలు` times, `నుంచి` ranges, `ఒక లక్ష…`, the period-word
   choices (`తెల్లవారుజామున` for 4–5 AM) and the attributive forms. They are
   engineering choices, not verified Telugu usage.
3. Whether a mid-sentence voice switch (and, for Padmavathi, a gender switch)
   is acceptable on a customer call.
4. Owner decision on the Sarvam round-trip spend above.

## Phase B.6 — normalization regression coverage, parity, blinded packet (2026-10-14)

**Scope:** local TTS text pipeline and benchmark tooling only. Sarvam stays
primary; production routing, `models/voice-local/manifest.json`, calendar
code and environment files are unchanged. No Sarvam request, no model
download (Indic Parler-TTS still deferred), no network. **No human has
listened to any audio; nothing below is a naturalness claim.**

### Defects found and fixed (both implementations, identical output)

Probing the B.5 pipeline with booking-style lines found these, all now fixed
and pinned by fixture cases:

| Input | B.5 output (what the voice was given) | Now |
| --- | --- | --- |
| `AR-2041` | `ay ar-two thousand forty one` | `ay ar, two zero four one` — always the English voice, letter and digit by digit, hyphen → short pause (never a segment break) |
| `AR2041`, `HALO-7Q2X9`, `2BHK` | `ARtwo thousand…`, `sevenQtwoXnine`, `twoBHK` | spelled; `10AM`, `5PM` and 5+-letter words (`COVID-19`) are not codes |
| `03/24/2026` | `zero three/twenty four/two thousand twenty six` (slashes reach espeak) | `March twenty fourth, …` / `…మార్చి ఇరవై నాలుగో తేదీ`; month-first only when day-first is impossible |
| `31/02/2026`, `13/13/2026` | slashes / a non-existent date | digit groups (`three one, zero two, …`); real calendar check incl. leap years |
| `2026/03/24` | slashes | same as ISO `2026-03-24` |
| `₹500 - ₹1,000`, `₹500-1,000` | `five hundred rupees - one thousand rupees` | `five hundred to one thousand rupees` / `ఐదు వందల నుంచి వెయ్యి రూపాయలు` |
| `₹2-3 lakh`, `₹1.50-₹2.50` | hyphen left between amounts | `two to three lakh rupees` / `రెండు నుంచి మూడు లక్షల రూపాయలు`; paise ranges said in full |
| `45,000/- రూపాయలు` | `…రూపాయలు రూపాయలు` | one రూపాయలు |
| `₹2.5L`, `₹5 Cr`, `lac` | `two rupees and fifty paiseL` | `two point five lakh rupees` |
| `$100` | `$one hundred` | `one hundred dollars` / `వంద డాలర్లు` |
| `+919848012345` | `nine one nine eight, four eight zero one, …` (fours) | `plus nine one, nine eight four eight zero, one two three four five` |
| `09848012345`, `+91 9848012345` | fours / one 10-digit run | `zero, 98480, 12345`; a written 10-digit group is always 5 + 5 |
| `(040) 2345 6789` | brackets reach espeak, no pause after the code | `zero four zero, two three four five, …` |
| `Sr. No.`, `Ref.`, `Opp.`, `Mob.`, `Ph.`/`Ph:`, `Appt.`, `Rd.`/`Rd`, `No. AR-2041` | left as is; the dot ended the sentence mid-line | `serial number`, `reference`, `opposite`, `mobile`, `phone`, `appointment`, `Road` (a `Rd.` before a capital keeps its sentence end), `number` |
| `051,000` (leading zero with a comma) | **Python worker raised `ValueError`** (synthesis failure); TypeScript silently dropped the comma | digit by digit in both |

Also aligned: Python's `round()` (half-to-even) vs `Math.round` in sample
counts (22,050 Hz × 10 ms gave 220 vs 221 samples); a whitespace-only script
run is dropped before the voice check in Python as in TypeScript.

Not changed, listed for a reviewer in
[`LOCAL_TELUGU_TTS_REVIEWER_DECISIONS.md`](LOCAL_TELUGU_TTS_REVIEWER_DECISIONS.md)
§D: ambiguous `03/04/2026` stays day-first; `5-2-40` (house number) is read as
a date; `St.` is left alone; lower-case codes are not codes.

### Parity evidence

- `tests/fixtures/local-tts-text-cases.json`: 55 → **100** shared cases (45 new
  across booking codes, numeric dates, prices, phone digits, abbreviations and
  Telugu-English code-switching), plus two new invariants in both suites: no
  slash, currency sign or bracket left for espeak, and a booking code is one
  English segment in either language.
- `npx tsx scripts/check-local-tts-text-parity.ts` (new): seeded random lines
  from 131 fragments (codes, dates, times, prices, phones, abbreviations,
  Telugu/English words, NBSP/ZWNJ, punctuation) × three voice sets, compared
  on normalized text, segments and error type, plus pause/trim sample counts
  at 5 rates × 7 durations. Result: **0 mismatches and 0 crashes in 103,000
  lines** (seeds 1–8 × 10,000, 2026 × 20,000, 7 × 3,000); before the fix above,
  seeds 1 and 2 found the `051,000` Python crash.
- Test runs: `test_local_tts_text.py` 11/11, worker suite 65 OK (1 skipped,
  as before); `tests/unit/voice/local-tts-text.test.ts` 110/110,
  `tests/unit/voice` 323/323; `tsc --noEmit`, ESLint and `check:architecture`
  clean.

### Latency and synthesis failures (no STT)

`benchmark-local-tts.py` gained `--phrases`; the 13 new lines are in
`scripts/local-tts-regression-phrases.json` (synthetic). The 28-line set is
unchanged, and its text plans are identical to B.5 `current` (0 of 56 differ),
so the B.5 audio and machine scores still describe those lines.

| Run (both voices, 3 repeats, warm) | Start load | Failures | First audio median V / P | Max V / P | RTF median V / P |
| --- | ---: | ---: | --- | --- | --- |
| B.5 `current`, 28 lines (13:07) | 3.70 | 0 / 56 | 312 / 346 ms | 836 / 826 ms | 0.11 / 0.11 |
| `b6-current`, same 28 lines (15:13) | 1.14 | 0 / 56 | 411 / 423 ms | 1,033 / 1,023 ms | 0.14 / 0.13 |
| `b6-current-r2`, same (15:17) | 3.31 | 0 / 56 | 392 / 475 ms | 1,025 / 1,203 ms | 0.14 / 0.14 |
| `b6-regression`, 13 new lines (15:14) | 3.43 | 0 / 26 | 440 / 442 ms | 996 / 857 ms | 0.15 / 0.14 |

Identical text plans gave medians up to 37 % apart between runs on this laptop
(i5-8265U, WSL2), so these runs **cannot show a latency change in either
direction**; they show no failures and the same order of magnitude. The text
pipeline itself costs a median 0.36 ms (Python) / 0.16 ms (TypeScript) per
line, max 0.7 ms, on the 41 lines. The slowest first audio of the new lines is
`k04` (≈0.85–1.0 s): a 112-character English booking confirmation with a code,
date and time stays one segment because the commas inside a code or date are
protected and never split.

### Blinded listening packet

`scripts/build-local-tts-blind-review.py` (new) built packet `b6` from
`b6-current`: Part A, మీకు/నీకు forced choice without text (c01–c04 × 2
voices); Part B, 7 booking-critical lines (phone digits, date, times, booking
confirmation, cancellation) as voice pairs in random order; gain-matched,
checksummed, key stored separately. Protocol and acceptance criteria:
[`LOCAL_TELUGU_TTS_BLIND_REVIEW.md`](LOCAL_TELUGU_TTS_BLIND_REVIEW.md).
**Not reviewed.**
