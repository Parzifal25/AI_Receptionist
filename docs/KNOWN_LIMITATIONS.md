# HALO — known limitations

Referenced from the voice gateway, the telephony adapter, the speech adapters
and the latency harness. Every entry here is something the code deliberately
does not claim. **Nothing in this file is a to-do list item that someone
forgot; each one is a claim that has not been earned yet.**

The rule this file exists to enforce: *a provider supporting something, a
test passing, and the product working are three different claims.* Do not
report one as another.

---

## Speech vendors (Phase 4.5 Sprint 1)

Real STT and TTS adapters now exist (`packages/providers/voice-vendors/`) and
are selectable by configuration. **Neither has ever been run against its live
vendor endpoint from this repository.** There are no credentials here.

> **Update (2026-10-15):** this paragraph is from Sprint 1 (2026-09-22). Since
> then, Sarvam STT/TTS has run live from a browser microphone through the
> Pipecat worker. The run on 2026-10-06 is self-reported in the
> `services/pipecat-worker/worker.py` docstring. Sarvam was also measured on
> the 11 benchmark clips cited under "Local speech" below. Neither is
> telephony, phone-band human Telugu or a native-speaker review, so the
> UNMEASURED rows in the table below still stand.

| Claim | Status |
| --- | --- |
| The adapters honour HALO's STT/TTS ports | **Proven** — same contract kit as the fakes, plus protocol tests |
| The vendor's documented protocol is implemented as documented | **Proven against the documentation**, never against the endpoint |
| The vendor accepts μ-law 8 kHz and lists Telugu | **Documented by the vendor**, not verified |
| HALO understands real Telugu speech | **UNMEASURED** |
| HALO speaks natural Telugu | **UNMEASURED** |
| Telugu/English code-switching inside one utterance works | **UNMEASURED** |
| Real end-to-end latency with real vendors | **UNMEASURED** |

Specifically outstanding:

- **Telugu WER on 8 kHz narrowband.** Telephony-band Telugu is usually worse
  than a vendor's published benchmark, and coverage differs sharply between
  vendors and between one vendor's model tiers. The feasibility audit's
  recommendation stands: evaluate at least two vendors on the same audio
  before committing to one.
- **TTS mean-opinion score from a native Telugu panel.** Not an automated
  metric. No score exists.
- **`endOfSpeechMs: 900`** is a hypothesis about Telugu pause structure tuned
  on mock audio. It must be re-tuned on real speech.
- **No transcription confidence.** The selected STT endpoint emits none (only
  a language-detection confidence, which is a different quantity). The adapter
  reports `confidence: null` and `reportsConfidence: false`. Consequence:
  HALO's low-confidence read-back of misheard names and numbers **does not
  fire** with this vendor. Inventing a confidence would switch that behaviour
  on using evidence that does not exist, so it is left off.
- **One socket per sentence chunk.** The TTS port's `synthesize()` is called
  per chunk, so the adapter opens a WebSocket per chunk. The handshake is
  inside `tts_first_byte`, i.e. measured rather than hidden. Connection reuse
  needs a pooling design that cannot leak one call's audio into another's.

## Local speech (Phase B)

`local` STT/TTS run open models in-process with no credential. Full numbers,
method and licences: [`LOCAL_SPEECH.md`](LOCAL_SPEECH.md). In short:

- Local Telugu STT is far below Sarvam (WER 67 % against 6 % on the same 11
  clips), unreliable on spoken digits, and occasionally emits another script.
  It is offline: no interim results and no confidence.
- Local TTS is intelligible to a recognizer; **no human has listened to it**.
  English words inside a Telugu line are spoken by a second (American
  English) voice.
- On the 4-core development laptop a local-mode browser call completed, but
  HALO's turn time was 3–15 s (median 7.5 s) against about 1 s with Sarvam.
- Not verified: a human microphone or listener, a phone line, concurrent
  calls, or any other host.
- sherpa-onnx bundles espeak-ng (GPL-3.0); review before distributing.

## The local voice loop

`scripts/local-call.ts` runs a real microphone and speaker against a real
gateway over the fake-carrier protocol. It is **development infrastructure**.

It proves vendors, the model, Telugu behaviour and real latency. It proves
**nothing about telephony**: there is no PSTN transport, no carrier jitter,
no packet loss, no codec negotiation and no Pipecat worker. A good local demo
is not a working phone call and must never be reported as one.

Two local-loop artefacts, both the client's and neither HALO's:

- on barge-in the gateway sends `clear`, but audio already handed to the
  operating system's audio buffer cannot be un-written, so a short tail is
  still heard;
- playback marks are acknowledged on receipt, which over-reports delivery by
  the speaker's buffer depth. The session's mark grace absorbs it.

## Telephony

- `TwilioMediaStreamProvider` is a reference adapter. No Twilio credentials
  exist here; it has never carried a real call.
- `services/pipecat-worker/` is a protocol contract, not a program: a
  transport shim and its tests, with no pipeline and no worker entry point.
  The Pipecat media path has never been run.
  **Corrected 2026-10-15 (`source`):** `worker.py` is now a runnable worker
  (VAD, STT, TTS, media gate and pacer), offline-tested over real WebSockets
  with fake speech. It ran browser-live against Sarvam on 2026-10-06
  (self-reported). It has still never carried a carrier call.
- Sessions live in one process's memory. A call's media socket must reach the
  instance that answered its webhook (single instance, or sticky routing).

## Latency

- `npm run voice:latency` measures **HALO's coordination overhead against
  injected vendor delays**. It is not a vendor measurement and its numbers
  must never be quoted as one.
- `context_ready` and `llm_first_token` (migration 0023) make the middle of
  the chain observable. `llm_first_token` is emitted **only** when the
  provider streamed; when it did not, `agent_turn.firstTokenMs` is explicitly
  `null` rather than zero.
- The local client reports the one stage the gateway cannot see — when audio
  actually reached the speaker — and nothing else.

## Context and tokens

- Token counts are **ESTIMATES**. Since Phase 4.5 Sprint 2 `ContextLimits`
  carries `maxInputTokens` alongside `maxTotalChars`, and both are enforced —
  but the token figure comes from a script-weighted heuristic
  (`packages/language/tokens.ts`), not a tokenizer and not a provider. The
  weights are reasoned, not measured, and are deliberately pessimistic on
  non-Latin script: they may over-charge Telugu, and the cost of that is a
  knowledge snippet dropped earlier than strictly necessary. A real provider's
  reported `input_tokens` is what replaces them; `context.built` already
  carries the estimate so the comparison is a subtraction.
- The audit's "2.70" figure (§B4) is **bytes per character, not characters per
  token**. No characters-per-token measurement for Telugu exists in this
  repository.
- `maxTotalChars` and `maxInputTokens` bound the builder's inputs, not the
  rendered prompt. The measured gap is ~3,100 characters (composer headings,
  the rules block, tool JSON schemas). `context.built` reports the rendered
  prompt's characters, bytes and estimated tokens separately so the gap is
  visible.
- Prompt caching is **not implemented**, and the current section order leaves
  almost no contiguous cacheable prefix on a mid-call turn (§B3).

## Language correctness

- `isSubstantiveQuestion` (`packages/knowledge/retrieval-query.ts`) recognises
  only `?` and English interrogative openers, so on a Telugu call
  `knowledgeGap` is always false and the unanswered-question escalation path
  cannot fire. **Fixed locally by W2.1 (2026-10-15):** per-language cues in
  `packages/language/question-cues.ts` cover Telugu script, romanized Telugu
  and Tenglish; English is unchanged. The cue lists are curated, a leading
  greeting still disqualifies a message (as in English), and a romanized cue
  word counts only when the rest of the message is independently Telugu.
- Confirmation detection **was** English-only and is no longer:
  `packages/language/confirmation.ts` (Phase 4.5 Sprint 2) reads Telugu and
  romanized Telugu, and refuses rejection, hedging, question forms and
  backchannels. What remains is that its phrase lists are **curated, not
  exhaustive** — Telugu transliteration is not standardised, so a yes spelled
  a way that is not listed reads as "no answer" and does not confirm. That is
  the safe direction and it is also a missed confirmation on a real call; it
  can only be tuned against real STT output.

The first is the failure pattern recorded in Phase 4 §6.5, and
`packages/language/` already ships the lexicon that fixes it.

## Other

- `collectionIds` is accepted by `ProviderKnowledgeResolver` and ignored;
  retrieval stays tenant-wide.
  **Corrected 2026-10-15 (`source`):** since the Layer 1 work of 2026-10-14,
  a non-empty `collectionIds` makes retrieval **fail closed**
  (`knowledge-resolver.ts`), rather than widening to the whole tenant. Scoped
  retrieval waits on [D14](DECISIONS.md#d14--layer-1-activation-and-approved-knowledge).
- `AgentVersion.model.provider` is never read: `getLLMProvider()` is a
  process-global env singleton, so a voice agent and a chat agent cannot use
  different models and a tenant cannot pin one.
- With `LLM_PROVIDER=gemini` the agent is offered **no tools** and cannot
  stream (the adapter declares both `false`). The runtime reports
  `tool.capability_downgraded`, so it is honest rather than silent — but it is
  a hard capability cliff behind one environment variable.
