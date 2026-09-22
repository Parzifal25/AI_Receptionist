# HALO Phase 4.5 — Sprint 1 report: the real voice loop

**Scope delivered:** a real STT adapter, a real TTS adapter, a local
microphone client, and the latency measurement framework the loop needs to be
worth running.

**The one sentence that matters:** every piece of the loop now exists and is
tested, and **no part of it has been run against a live speech vendor**,
because no credentials exist in this repository. Selecting a vendor is a
configuration decision. It is not a quality claim, and nothing below should be
read as one.

Read alongside [`PHASE4_5_FEASIBILITY.md`](PHASE4_5_FEASIBILITY.md) (the audit
this implements), [`LOCAL_VOICE_LOOP.md`](LOCAL_VOICE_LOOP.md) (how to run it)
and [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) (what is still unearned).

---

## A. What changed

### New

| File | Why |
| --- | --- |
| `packages/providers/voice-vendors/websocket.ts` | The one WebSocket seam the speech adapters use. Injectable, so every protocol behaviour is testable offline with no credentials and no network. |
| `packages/providers/voice-vendors/sarvam-stt-provider.ts` | Real streaming STT behind `StreamingSttProvider`. |
| `packages/providers/voice-vendors/sarvam-tts-provider.ts` | Real streaming TTS behind `StreamingTtsProvider`. |
| `packages/providers/voice-vendors/factory.ts` | Vendor selection from explicit, already-validated configuration — never from `process.env`. |
| `scripts/local-call.ts` | The local development client. Not a service. |
| `supabase/migrations/0023_voice_latency_marks.sql` | Widens `call_events.type` for the two new marks. Additive; no column change, no backfill. |
| `docs/LOCAL_VOICE_LOOP.md` | Operator guide: requirements, setup, running, reading latency, troubleshooting. |
| `docs/KNOWN_LIMITATIONS.md` | Referenced from the gateway, the Twilio adapter and the latency harness since Phase 3, and missing until now. |
| `tests/fixtures/voice-smoke-utterances.ts` | The manual English/Telugu/Tenglish smoke set. |
| `tests/mocks/vendor-socket.ts` | The scripted socket double. |
| 5 new test files | See §I. |

### Modified

| File | Change |
| --- | --- |
| `services/voice-gateway/config.ts` | `sttProvider`/`ttsProvider` widened past `fake`; vendor credential, model, mode and base-URL settings; three refinements that fail closed. |
| `services/voice-gateway/index.ts` | Builds STT/TTS through the factories instead of constructing fakes directly. |
| `packages/core/domain/voice.ts` | `CALL_EVENT_TYPES` += `context_ready`, `llm_first_token`. |
| `packages/voice/turn-handler.ts` | `VoiceTurnResult.timings?: VoiceTurnTimings` — optional, so handlers that cannot break a turn down omit it. |
| `packages/voice/phone-channel-adapter.ts` | Passes an observation-only `onDelta`; surfaces the runtime's timing breakdown. |
| `packages/voice/voice-session.ts` | Emits the two marks and carries the breakdown on `agent_turn`. |
| `tests/mocks/voice-harness.ts` | `ScriptedTurnHandler` can report timings. |
| `tests/unit/voice/call-state-sql-parity.test.ts` | Asserts the **effective** call-event constraint across all migrations, not 0020's inline list. |
| `services/voice-gateway/README.md` | Vendor configuration table; pointer to the local loop. |

### Deliberately NOT modified

`packages/runtime/` (prompt composer, agent runtime, response validator, tool
registry and boundary), `packages/voice/gateway.ts`, `packages/voice/audio.ts`,
`packages/voice/pipecat/`, `services/pipecat-worker/`, the telephony
providers, the golden corpus, and every existing test's assertions.

**One deviation from the audit's file plan:** it proposed
`packages/providers/stt/` and `packages/providers/tts/` with a factory each.
One directory (`voice-vendors/`, parallel to `voice-fakes/`) holds both plus
the shared socket seam, which would otherwise need a third directory or a
cross-directory relative import.

---

## B. Architecture

```
microphone
  │  48 kHz PCM16 (sox / arecord / ffmpeg — an external process)
  ▼
scripts/local-call.ts ──── resample to 8 kHz ──── μ-law ──── base64
  │                        (box low-pass decimation, in the CLIENT)
  │  HMAC-signed webhook → stream token → WS /media, JSON lines
  ▼
services/voice-gateway/server.ts        signature + stream-token check
  ▼
VoiceGateway → VoiceSession             state machine, endpointer, barge-in
  ├──▶ SarvamSttProvider                mulaw 8 kHz up, partial/final down
  ├──▶ PhoneTurnHandler → AgentRuntime  UNCHANGED
  │       └── LLM → tools → validateReply (act-then-narrate)
  └──▶ SarvamTtsProvider                μ-law 8 kHz back
  ▼
WS /media → local-call.ts → speaker
```

No new process. No second voice path. `VOICE_MEDIA_ENGINE` stays
`in_process`; the Pipecat path is untouched.

---

## C. STT

| | |
| --- | --- |
| **Provider** | Sarvam AI realtime speech-to-text, `wss://api.sarvam.ai/speech-to-text-realtime/ws` |
| **Adapter** | `packages/providers/voice-vendors/sarvam-stt-provider.ts` |
| **Languages declared** | te-IN, en-IN, hi-IN, bn-IN, gu-IN, kn-IN, ml-IN, mr-IN, od-IN, pa-IN, ta-IN |
| **Streaming** | Yes — `transcript.partial` → `transcript.final`, plus vendor VAD (`vad.speech_start` / `vad.speech_end` → `providerEndpointing: true`) |
| **Audio format** | μ-law 8 kHz mono (the telephony format, no conversion), PCM16 8 kHz, PCM16 16 kHz |
| **Configuration** | `VOICE_STT_PROVIDER=sarvam`, `VOICE_STT_API_KEY` (required), `VOICE_STT_MODEL`, `VOICE_STT_MODE`, `VOICE_STT_BASE_URL` |
| **Tests** | 20 protocol tests + the shared contract kit |

**Why this vendor.** It is the one endpoint that accepts μ-law 8 kHz telephony
audio *and* documents Telugu plus code-mixed Indian-language input. Deepgram
nova-3 transcribes Telugu (`language=te`) but its `language=multi`
code-switching set is English, Spanish, French, German, Hindi, Russian,
Portuguese, Japanese, Italian and Dutch — **Telugu is not in it**, so Tenglish
inside one utterance is unavailable there. Google and Azure both cover Telugu
but reach streaming through gRPC or a vendor SDK, which would be the first SDK
dependency in a repository whose every other adapter is raw `fetch`.

**Two capability facts that change HALO behaviour, not just documentation:**

1. **No transcription confidence exists on this endpoint.** It emits a
   *language-detection* confidence, which is a different quantity. The adapter
   reports `confidence: null` and `reportsConfidence: false`.
   **Consequence: HALO's low-confidence read-back of misheard names and
   numbers does not fire with this vendor.** Laundering language confidence
   into transcript confidence would switch that behaviour on using evidence
   that does not exist. The qualification schema's own `confirm` step still
   guards the two fields that matter most (`monthly_bill`, `phone`).
2. **The vendor reports the detected language only under auto-detection.** So
   the adapter requests auto-detection exactly when the session declares
   alternative languages — the code-switching case — and reports `null`
   otherwise, rather than echoing back the language it was configured with as
   if it had been detected.

**Port unchanged.** No mismatch was found that required widening it.

---

## D. TTS

| | |
| --- | --- |
| **Provider** | Sarvam AI Bulbul, `wss://api.sarvam.ai/text-to-speech/ws` |
| **Adapter** | `packages/providers/voice-vendors/sarvam-tts-provider.ts` |
| **Languages declared** | the same eleven |
| **Streaming** | Yes — chunked base64 audio, terminated by a completion event |
| **Audio format** | μ-law 8 kHz mono direct (no conversion in the media path), PCM16 at 8/16/22.05/24 kHz |
| **Configuration** | `VOICE_TTS_PROVIDER=sarvam`, `VOICE_TTS_API_KEY`, `VOICE_TTS_DEFAULT_VOICE` (both required), `VOICE_TTS_MODEL`, `VOICE_TTS_BASE_URL` |
| **Tests** | 15 protocol tests + the shared contract kit |

**No default voice.** Which voice a tenant's callers hear is a decision, not a
fallback, so the gateway refuses to start with a real TTS vendor and no voice.
An agent version's `voice.ttsVoice` overrides the deployment default per
tenant.

**Cancellation** is the contract that matters on a phone call. Abort closes
the socket and completes the iterator without throwing at the media loop, so
barge-in releases the vendor rather than leaving a synthesis running.

**Format conversion** is isolated in the adapter: it requests the format the
session asked for, and carries an odd trailing byte across frames so PCM16
output is always whole samples. The voice protocol was not altered to fit the
vendor.

**A real cost, measured rather than hidden.** The TTS port's `synthesize()` is
called once per sentence chunk, so this adapter opens one WebSocket per chunk.
That handshake is inside `tts_first_byte`. Connection reuse needs a pooling
design that cannot leak one call's audio into another's — Sprint 2/3.

---

## E. Local microphone client

| | |
| --- | --- |
| **Entry point** | `npx tsx scripts/local-call.ts --from +91… --to +91…` |
| **Dependencies** | `ws` (already a dependency) and an external recorder/player: sox, ALSA or ffmpeg. **No new npm dependency.** |
| **Input** | PCM16LE mono at `--capture-rate` (default 48000) on the recorder's stdout |
| **Output** | PCM16LE mono 8 kHz to the player's stdin |
| **On the wire** | base64 μ-law 8 kHz, JSON lines, 20 ms frames — verified against `FakeMediaCodec`, not assumed |
| **How to run** | [`LOCAL_VOICE_LOOP.md`](LOCAL_VOICE_LOOP.md) |

Resampling happens in the client, never in `packages/voice/audio.ts`: the
media contract is not negotiable because the hardware on one desk produces
48 kHz. Each output sample averages its input window — a box low-pass, crude
next to a windowed-sinc, but it removes the aliasing a bare
take-every-Nth-sample decimation would fold into the speech band.

Neither phone number has a default. Which tenant answers is a routing fact the
script must not invent, so it refuses to run without both.

---

## F. Latency

### The framework (built)

`CALL_EVENT_TYPES` gains `context_ready` and `llm_first_token`, both measured
from end-of-speech — the wait the caller actually experiences.

| Brief | HALO mark | Status |
| --- | --- | --- |
| T0 speech begins | `speech_started` | existed |
| T1 endpoint detected | `endpoint` | existed |
| T2 STT final | `stt_final` | existed |
| T3 context ready | `context_ready` | **new** |
| T4 LLM first token | `llm_first_token` | **new** |
| T5 LLM complete | `agent_turn.modelMs` | **new** (detail) |
| T6 validation complete | `agent_turn.validationMs` | **new** (detail) |
| T7 TTS request begins | `tts_start` | existed |
| T8 first TTS audio | `tts_first_byte` | existed |
| T9 first audio played | client-side only | **new**, in the client's report |

T9 cannot be observed server-side: the gateway knows when audio left on the
wire, not when it reached a speaker. The local client reports that one stage
and nothing else.

`llm_first_token` is emitted **only when the provider streamed**. When it did
not, nothing is emitted and `agent_turn.firstTokenMs` is explicitly `null` —
zero would read as an instant response.

### Measurements

**No real-provider latency exists.** Nothing below is a vendor measurement.

| Measurement | Value | What it is |
| --- | --- | --- |
| `npm run voice:latency`, `turn_complete` p50 / p95 | 1003 / 1008 ms | HALO's coordination overhead against **injected** vendor delays (stt 250, model 600, tts 200 ms). ~1 ms of it is HALO's. |
| `endpoint` p50 | 400 ms | the configured hangover, not a measurement |
| Local client, end-of-speech → speaker, n=2 | p50 717 ms, worst 1459 ms | a **synthetic** capture source and a counting sink against fake STT/TTS. Proves the loop runs; says nothing about vendors. |

### The one thing that was actually exercised

The client was run as a real process against a live gateway (real HTTP, real
WebSocket, `InMemoryCallStore`, fakes below the ports) with a synthetic
microphone and a counting speaker: **six turns handled, audio flowing both
ways, clean hang-up, latency report printed.** That run caught a defect in the
client's own report — a p95 over two samples printed *below* an observed
sample — now fixed to p50 / worst / n.

**Real-microphone validation is BLOCKED in this environment:** no audio tools
are installed (`sox`, `arecord`, `aplay`, `ffmpeg` all absent) and WSL2 here
has no audio stack.

---

## G. Telugu / Tenglish

Three different claims, kept apart:

| Claim | Status |
| --- | --- |
| The vendor supports Telugu and code-mixed input | **Documented by the vendor.** Not verified. |
| The adapters carry Telugu text and telephony audio correctly | **Proven** — Telugu and Tenglish finals, Telugu/English/mixed synthesis, all asserted |
| **HALO understands real Telugu speech** | **UNMEASURED** |
| **HALO produces natural Telugu speech** | **UNMEASURED** |

### Smoke set

`tests/fixtures/voice-smoke-utterances.ts` — eight categories (greeting, solar
inquiry, electricity bill, price, appointment, callback, WhatsApp, objection),
each in English, Telugu and Tenglish, with what to watch for.

**Every non-English line is drawn from text already in this repository** — the
Arunodhaya qualification questions, the objection cue lists, the pending-fact
questions — or is a neutral utterance with no business content. **No
Arunodhaya fact is invented, and a test enforces it.** Every Arunodhaya fact
is currently `supplied_pending`: there is no verified price, subsidy or
warranty here to build an utterance around, and a smoke set that quietly
minted one would be the exact failure `supplied.ts` exists to prevent, while
looking like documentation rather than a bug. That test also guards its own
premise — if a fact ever becomes verified, it fails rather than continuing to
pass on stale reasoning.

Two utterances carry most of the value:

- **price** — the agent must say it does not have the figure and offer a
  person. Any number, including a range or a "typically around", is a failure.
- **appointment** — act-then-narrate: "booked" only after the scheduling tool
  actually succeeded.

**The smoke set has not been run**, because running it needs a microphone, a
credentialled vendor and a native Telugu listener. None of the three exists
here.

### Known Telugu limitations, unchanged by this sprint

- `isSubstantiveQuestion` is English-only, so on a Telugu call `knowledgeGap`
  is always false and unanswered-question escalation cannot fire.
- `CONFIRMATION_RE` is English-only, so a Telugu "సరే" does not confirm a
  confirmation-gated tool.
- `endOfSpeechMs: 900` is a hypothesis tuned on mock audio.

---

## H. Token baseline

Sprint 1 implements no token optimization, and **changed context size by
zero**. Measured before and after, with `npm run phase4:context`:

| Configuration | Rendered chars | Budgeted | Δ |
| --- | ---: | ---: | ---: |
| web-chat, no Phase 4 sections | 8,816 | 4,571 | **0** |
| voice, no Phase 4 sections | 8,908 | 4,277 | **0** |
| voice, with Phase 4 sections | 11,612 | 6,975 | **0** |

Across the golden corpus (197 real turns, `npm run eval:arunodhaya`), assembled
system prompt: **min 11,334 / p50 11,514 / p95 12,069 / max 12,382** chars —
also unchanged.

Output tokens are provider-reported and unchanged. Input tokens from a real
provider remain unmeasured (the corpus runs a scripted model).

Nothing was added to the prompt: no voice instructions, no provider text, no
duplicated schemas. The adapters sit entirely below the ports and the runtime
context pipeline was not touched. Prompt caching, section reordering and the
multilingual token budget are explicitly **not** in this sprint.

---

## I. Tests

```bash
npm test                                   # 101 files, 999 tests — all pass
npm run typecheck                          # clean
npm run lint                               # clean
npm run check:architecture                 # OK
npm run check:neutral                      # OK
npm run preflight:ci                       # passes (with env loaded)
npm run eval:arunodhaya                    # 50/50, unchanged
npm run voice:latency                      # mock-provider baseline
```

**Baseline before this sprint: 94 files / 932 tests.** Now 101 / 999:
**+7 files, +67 tests.** No test was deleted, skipped or weakened.

| File | Tests | Covers |
| --- | ---: | --- |
| `tests/unit/voice/sarvam-stt.test.ts` | 20 | success, partial→final, provider error, timeout, cancellation/close, malformed response, Telugu final, Tenglish final, buffering, bounded queue, auth classification, redaction |
| `tests/unit/voice/sarvam-tts.test.ts` | 15 | success, Telugu, English, mixed, empty/invalid, provider failure, timeout, mid-stream abort, whole-sample alignment, unsupported format |
| `tests/unit/voice/speech-vendor-config.test.ts` | 8 | fail-closed selection, defaults, unknown vendor, unknown mode |
| `tests/unit/voice/latency-marks.test.ts` | 7 | both marks, shared time origin, `agent_turn` breakdown, no invented first-token, silence when unreported, no transcript text |
| `tests/unit/voice/smoke-utterances.test.ts` | 7 | coverage, scripts, **no invented business fact**, sourcing |
| `tests/contracts/sarvam.contract.test.ts` | 5 | the real adapters against the **same contract kit as the fakes** |
| `tests/integration/local-voice-loop.test.ts` | 5 | the client's protocol against the real gateway, plus token-mismatch and unsigned-webhook refusals |

**One existing test was changed, and strengthened rather than weakened.**
`call-state-sql-parity.test.ts` asserted the TypeScript call-event set against
0020's inline CHECK list. It correctly caught this sprint's widening. It now
computes the **effective** constraint across all migrations, so a future ALTER
cannot silently drift from the TypeScript set either.

### Not run

- `npm run check:migrations` — needs a fresh Supabase-provisioned database
  (the `auth` schema); the local one already has the schema applied and
  resetting it would wipe the developer's data. **Instead: migration 0023 was
  applied to the live local database inside a transaction** — constraint
  replaced, both new values present, all existing values kept — and rolled
  back, leaving the database unchanged.
- `npm run check:rls` — refuses to run without an explicitly separate
  throwaway database. `check:architecture` verifies RLS statically and passes;
  0023 creates no table, so RLS on `call_events` is unchanged from 0020.

---

## J. Security

| Confirmation | Evidence |
| --- | --- |
| **No secrets committed** | Credentials come only from the gateway's env schema. A test asserts the key travels in a header and never in the URL. Vendor error text is redacted before it reaches logs or `call_events`, and a test asserts that. `git diff` scanned. |
| **Tenant isolation unchanged** | No change to routing, the stream token, `resolveInboundRoute` or any store. Tenant identity still comes only from the dialled number, server-side. The local client cannot attach to another call: a token minted for a different call id is rejected (1008), asserted. |
| **Provider credentials server-side** | Adapters take an API key as a constructor argument; no `process.env` in them. Nothing vendor-related reaches frontend code. The local client holds only the fake-carrier webhook secret. |
| **Tool authorization unchanged** | `packages/runtime/tools/` untouched. The closed registry, the four-step boundary and the architecture gate all pass unchanged. |
| **Act-then-narrate unchanged** | `response-validator.ts` untouched. The delta consumer is observation-only: `invokeModel` still accumulates the complete result before returning, so the reply is validated whole and nothing is spoken from a delta. Golden corpus 50/50 unchanged. |
| **Fails closed** | Selecting a real vendor without its credential — or TTS without a voice — refuses startup. A gateway that answers a call it cannot speak is worse than one that will not boot. |

**One finding worth raising.** `.env.example` is matched by `.gitignore`'s
`.env*` and is **untracked**: edits to it do not ship. The vendor variables are
therefore documented in `services/voice-gateway/README.md` and
`LOCAL_VOICE_LOOP.md`, which are tracked. Un-ignoring `.env.example` is
repository hygiene outside this sprint's scope, so it was left alone rather
than force-added.

---

## K. Remaining blockers

**Hard-blocked in this environment:**

1. **No vendor credentials.** Every real-provider claim — Telugu WER, TTS
   quality, real latency, real token counts, the char-to-token ratio for
   Telugu — stays unmeasured. The adapter boundary is correct and contract
   tested; only the live run is missing.
2. **No audio devices.** `sox`, `arecord`, `aplay` and `ffmpeg` are all
   absent and WSL2 here has no audio stack, so a real-microphone run was not
   possible. The client was validated as a process against a live gateway with
   synthetic capture and playback instead.
3. **No native Telugu listener.** TTS mean-opinion score cannot be produced by
   any automated means.

**Unchanged from before:** real PSTN transport, carrier-side barge-in
perception, multilingual retrieval quality, and the Pipecat worker, which
remains a protocol contract that has never been run.

**Not blocking, but should be decided before spending vendor credits:** the
audit recommends evaluating **two** STT vendors on the same audio before
committing. Sprint 1 deliberately shipped one, per the brief. Telugu coverage
differs sharply between vendors and between one vendor's model tiers, and 8 kHz
narrowband is usually worse than a published benchmark.

---

## L. Sprint 2 readiness

Sprint 2 can now build, in rough order of value:

1. **Run the loop.** With a key and a microphone, everything else here becomes
   measurable in an afternoon: Telugu WER, whether `mode=codemix` or
   `mode=transcribe` reads better for a Tenglish caller, real TTFT, real token
   counts per turn, and the real char-to-token ratio for Telugu.
2. **Re-tune `endOfSpeechMs`** on real Telugu speech. The current 900 ms is a
   hypothesis from mock audio.
3. **Token optimization (audit §C.4 items 1, 3–7).** The measurement framework
   and an unchanged baseline are both in place. Section reorder for a
   contiguous cacheable prefix, drop the prose tool section when the provider
   takes native tools, channel-filter the doctrine, merge the overlapping phone
   rule blocks, make the retrieved-documents rule conditional, render system
   actions as fields.
4. **Wire runtime events into `call_events`.** The gateway still passes neither
   `events` nor `onTurnOutput`, so per-turn runtime telemetry reaches logs
   only. `context.built` already carries `promptChars`; adding `promptBytes`
   makes the multilingual under-count visible.
5. **The language-correctness fixes the loop will expose.**
   `isSubstantiveQuestion` and `CONFIRMATION_RE` are both English-only and
   `packages/language/` already ships the lexicon that fixes them. Both are
   the Phase 4 §6.5 pattern, one package over.
6. **A second STT vendor**, evaluated on the same audio. The port needs no
   change; it is one file and one enum value.
7. **TTS connection reuse**, once the per-chunk handshake cost is a measured
   number rather than a predicted one.

**Explicitly still deferred:** prompt caching (needs the port extension and a
review), streaming the reply into TTS before validation (needs incremental
validation designed first — do not trade act-then-narrate for latency), and
per-agent model/provider selection.
