# HALO Phase B — Telugu STT human review

Review the two preserved Telugu STT outputs against each reference. The first
section is the human-read Telugu FLEURS set. The audio files are not present in
the preserved workspace artifacts; see [Evidence gaps](#evidence-gaps). The
second section is a separate synthetic receptionist set. Do not treat its
synthetic audio as human speech.

For each row, listen to the corresponding clip if available and record whether
the meaning is preserved, then note the errors that matter. Leave the transcript
text as shown; do not edit it while reviewing.

**Candidate:** `vasista22/whisper-telugu-base` q5_1, `audio_ctx=512` (whisper.cpp).
**Baseline:** sherpa-onnx Omnilingual 300M CTC int8.

## Human-read Telugu FLEURS clips

Results below are the preserved `fleurs8` rows (8 kHz wire-band audio) from the
two model result files. Reference and output strings are copied as stored,
including their original scripts and wording.

### `fleurs-te-0`

- **Reference:** ఈ రహస్య గ్రామాన్ని చుట్టి రావడానికి ఒక అరగంట సమయం పడుతుంది
- **Candidate:** రహస్య గ్రామాన్ని చుట్టి రావడానికి ఒక అర్ధంత సమయం పడుతుంది
- **Baseline:** ఈ రహస్య గ్రామాన్ని చుటురావడానికి ఒక అరగంత సమయం పడతుంది
- **Meaning preserved?** Reviewer: ____________________
- **Errors that matter:** ______________________________________________

### `fleurs-te-1`

- **Reference:** అది నాకు అర్థం కాలేదు ఖచ్చితంగా న్యాయం కాదు
- **Candidate:** అది నాకు అర్ధం కాలేదు కచ్చితంగా న్యాయం కాదు
- **Baseline:** అదినాక అర్థం కాలెదు పశ్చితంగా న్యాయంు కాదు
- **Meaning preserved?** Reviewer: ____________________
- **Errors that matter:** ______________________________________________

### `fleurs-te-2`

- **Reference:** మృతదేహం సుమారు ఒక రోజు పాటు అక్కడ ఉందని పోలీసులు చెప్పారు
- **Candidate:** ప్రతి దేహం సుమారు ఒక రోజు పాటు అక్కడే ఉందని పరిశుధులు చెప్పారు
- **Baseline:** ृथदेहन चुमार अकरोजी पाटो अकडे हंदानी पोलिसील चेयार
- **Meaning preserved?** Reviewer: ____________________
- **Errors that matter:** ______________________________________________

### `fleurs-te-3`

- **Reference:** ఆర్థోడాక్స్ క్రిస్టియన్ మోల్డోవాలో ప్రధాన మతంగా ఉంది
- **Candidate:** ఆటోడాగ్ క్రిస్టియన్ మెల్డోవాలో ప్రధాన మతంగా ఉంది
- **Baseline:** ార్tోడాక్స్ క్రిస్టియన్ మెళ్డోవాలు ప్రధాన మతంగా ఉంది
- **Meaning preserved?** Reviewer: ____________________
- **Errors that matter:** ______________________________________________

### `fleurs-te-4`

- **Reference:** అది నాకు అర్థం కాలేదు ఖచ్చితంగా న్యాయం కాదు
- **Candidate:** అది నాకు అడ్డం కాలేదు ఖచ్చితంగా న్యాయం కాదు
- **Baseline:** అదినాకు అడ్డం కాలేదు కచ్చితంగా న్యాయం కాదు
- **Meaning preserved?** Reviewer: ____________________
- **Errors that matter:** ______________________________________________

### `fleurs-te-5`

- **Reference:** కారు డీకొట్టినప్పుడు ముగ్గురు వ్యక్తులు ఇంట్లో ఉన్నప్పటికీ ఎవ్వరూ గాయపడలేదు
- **Candidate:** పార్‌రెడ్డి కొట్టినప్పుడు మొక్కు వ్యక్తులు ఇంట్లో ఉన్నప్పటికీ ఎవరూ గాయపడలేదు
- **Baseline:** ఆరడీ కొట్నప్పుడు ముక్కు వెక్తిరు ఇంట్లా ఉన్నప్పటికి ఎవరుగా అయపడలేదు
- **Meaning preserved?** Reviewer: ____________________
- **Errors that matter:** ______________________________________________

### `fleurs-te-6`

- **Reference:** అది నాకు అర్థం కాలేదు ఖచ్చితంగా న్యాయం కాదు
- **Candidate:** అది నాకు అర్ధం కాలేదు ఖచ్చితంగా న్యాయం కాదు
- **Baseline:** అది నాకు అర్థం కాలేదు ఖచ్చితంగా నియాయం కాదు
- **Meaning preserved?** Reviewer: ____________________
- **Errors that matter:** ______________________________________________

### `fleurs-te-7`

- **Reference:** అతను wifi డోర్ బెల్ నిర్మించాడు అని చెప్పాడు
- **Candidate:** అతను వైఫై డోర్‌బెల్‌ నిర్మించాడు అని చెప్పాడు
- **Baseline:** అతను వైfై డor్బెల్ నిర్మించాడు అని చెప్పాడు
- **Meaning preserved?** Reviewer: ____________________
- **Errors that matter:** ______________________________________________

## Synthetic receptionist clips (separate set)

These seven 8 kHz clips are synthetic Sarvam TTS receptionist examples. The
reference and both output strings below are copied from the preserved
`extra-domain-8k.json`. The reference is the stored transcript for the same
audio. These are not human-read FLEURS clips.

### `dom-te-0` — synthetic audio

- **Reference:** నమస్కారం, నాకు రేపు ఉదయం పది గంటలకు అపాయింట్మెంట్ కావాలి.
- **Candidate:** నమస్కారం నాకు రేపు ఉదయం పది గంటలకు అపాయింట్మెంట్ కావాలి
- **Baseline:** నమస్కారం నాకు రేపు ఉదయం పదిగంటలకు అపాయింట్మెంట్ కావలి
- **Meaning preserved?** Reviewer: ____________________
- **Errors that matter:** ______________________________________________

### `dom-te-1` — synthetic audio

- **Reference:** మీ కార్యాలయం ఎక్కడ ఉంది, ఎన్ని గంటలకు తెరుస్తారు?
- **Candidate:** మీ కార్యాలయం ఎక్కడ ఉంది ఎన్ని గంటలకు తెరుస్తారు
- **Baseline:** మీ కార్యాలఏమ ఎక్కడ ఉంది ఎన్ని గంటలకు తెరుస్తారు
- **Meaning preserved?** Reviewer: ____________________
- **Errors that matter:** ______________________________________________

### `dom-te-2` — synthetic audio — **high risk: phone number**

- **Reference:** నా ఫోన్ నంబర్ తొమ్మిది ఎనిమిది నాలుగు ఎనిమిది సున్నా ఒకటి రెండు మూడు నాలుగు ఐదు.
- **Candidate:** నా ఫోన్ నెంబర్ తొమ్మిది ఎనిమిది నాలుగు ఎనిమిది సున్నా ఒకటి రెండు మూడు నాలుగు ఐదు
- **Baseline:** నా ఫೋన్ నంర 984 8మ సున్న ఒ 2ె34గోయిదు
- **Meaning preserved?** Reviewer: ____________________
- **Errors that matter:** ______________________________________________

### `dom-mix-0` — synthetic audio

- **Reference:** నాకు రేపు మార్నింగ్ పది గంటలకు appointment కావాలి.
- **Candidate:** నాకు రేపు మార్నింగ్ పది గంటలకు అపాయింట్‌మెంట్ కావాలి
- **Baseline:** నాకు రేపు మార్ణింగ్ పదిఘంటలకు అపాయింట్మెంట్ కావాలి
- **Meaning preserved?** Reviewer: ____________________
- **Errors that matter:** ______________________________________________

### `dom-mix-1` — synthetic audio

- **Reference:** మీ office timings ఏంటి, Sunday open ఉంటుందా?
- **Candidate:** మీ ఆఫీస్ టైమింగ్స్ ఏంటి సండే ఓపెన్ ఉంటుందా
- **Baseline:** మీ ఆఫీస్ టైమింగ్సఏంటి సండే ఒ్పనుంటుందా
- **Meaning preserved?** Reviewer: ____________________
- **Errors that matter:** ______________________________________________

### `dom-mix-2` — synthetic audio

- **Reference:** Solar installation కి total cost ఎంత అవుతుంది?
- **Candidate:** సోలర్ ఇన్స్టాలేషన్ టోటల్ కాస్ట్ ఎంత అవుతుంది
- **Baseline:** సోలర్ ఇన్స్టాలేషiన్ కి టోటల్ కాస్ట్ యంతో అవుతుండి
- **Meaning preserved?** Reviewer: ____________________
- **Errors that matter:** ______________________________________________

### `dom-mix-3` — synthetic audio — **high risk: cancellation / rescheduling**

- **Reference:** నా booking cancel చేసి next week కి reschedule చేయండి.
- **Candidate:** నా బుకింగ్ క్యాన్సర్ చేసి నెక్స్ట్ వీక్ చేయండి
- **Baseline:** నా బుకింగ్ కాన్సిల్ చేసి నెక్ట్ వీక్ కిరీషెడ్యుల్ చేయండి
- **Meaning preserved?** Reviewer: ____________________
- **Errors that matter:** ______________________________________________

## Evidence and gaps

- Human-read Telugu FLEURS references and candidate outputs: `models/local-speech-benchmark/results/stt-wcpp-te-base-q5_1_ctx512.json`, rows `fleurs-te-0` through `fleurs-te-7`, set `fleurs8`.
- Human-read Telugu FLEURS references and baseline outputs: `models/local-speech-benchmark/results/stt-sherpa-omni-300m.json`, rows `fleurs-te-0` through `fleurs-te-7`, set `fleurs8`.
- Synthetic receptionist references and outputs: `models/local-speech-benchmark/results/extra-domain-8k.json`.
- Benchmark notes and FLEURS description: `docs/LOCAL_SPEECH_BENCHMARK.md`.
- **Missing evidence:** No preserved FLEURS audio clips were found in the workspace. The result JSON files preserve the reference text and model output strings, but not the audio. A reviewer therefore needs the separately retained clips to listen and complete the meaning/error fields. No transcript has been reconstructed to fill this gap.
- No separate Sarvam transcript for the FLEURS clips appears in these result rows; this review uses the stored `ref` field as reference and does not add a Sarvam output column.
