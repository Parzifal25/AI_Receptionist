# HALO Phases 3 & 4 — Execution Plan and Checklist

**Started:** 2026-09-16 · **Base commit:** `9898faa` (clean tree; Phases 0–2 committed) · **Model:** Claude Opus 5
**Status legend:** COMPLETE · PARTIALLY COMPLETE · VERIFIED (real environment) · MOCK-VERIFIED (deterministic fakes) · NOT VERIFIED · BLOCKED · OUT OF SCOPE · TODO · IN PROGRESS

This file is the live checklist. Every row is updated with files, tests and results as work lands.

---

## 0. Scope reconciliation (read first)

The brief for this work names **Phase 3 = Voice Foundation / Real-time Voice Gateway** and
**Phase 4 = Telugu-first Arunodhaya demo**. The authoritative plan
(`docs/HALO_IMPLEMENTATION_PLAN.md`) numbers the same work differently:

| Brief | Plan sections it maps to | Plan's own gate / dependency | How it is handled here |
| --- | --- | --- | --- |
| Phase 3 — Voice foundation | §P5.1–P5.6, §P5.9 (voice gateway, ports, call state machine, calls data model, media-loop behaviours) | §P4 vendor GO/NO-GO (needs vendor accounts, 8 kHz native-speaker recordings, MOS panel) | Build the **provider-neutral** foundation with deterministic fakes and contract tests. §P4 vendor evaluation is **BLOCKED** (no credentials, no native-speaker panel) and is not faked. Nothing in the foundation pre-selects a vendor. |
| Phase 4 — Telugu Arunodhaya demo | §P3.6 (language packs + deterministic Telugu/Indian parsers), §P3.7 (Telugu prompt policy), §P8.1–P8.14 (agent config, qualification, escalation, outcomes, appointment flow) | §P3.2 embedding decision memo, §P3.5 native-reviewed eval set, §P8.13 ⟨SUPPLIED⟩ business documents | Generic multilingual + qualification capability in `packages/`; Arunodhaya **configuration only** outside `packages/`. Business facts that must be ⟨SUPPLIED⟩ are **not invented** — they are explicit placeholders that force the agent to defer to a human. Multilingual retrieval (§P3.2–P3.5) is **BLOCKED** on the embedding decision and eval set. |
| — | §P5.7 outbound campaigns, §P5.8 DNC registry/DLT | regulatory + vendor | **OUT OF SCOPE** for this batch (internal DNC suppression via outcome is in scope). |
| — | §P4 "spike code is never merged" | — | Not applicable: nothing here is spike code; the foundation is vendor-neutral production-shaped code with fakes, which the plan's §P5 requires regardless of which vendor wins §P4. |

Plan invariants that constrain every task (§2.4): Core stays business-agnostic (`check:neutral`);
dependency direction (`check:architecture`); RLS in the same migration; invariants in Postgres;
act-then-narrate; deterministic state outside the model; closed tools; one runtime, many channels.

## 1. Baseline (executed 2026-09-16, before any change)

| Gate | Result |
| --- | --- |
| `git status` | clean, `main` @ `9898faa` |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint` | exit 0 |
| `npx vitest run` | 67 files, 565 tests passed |
| `npm run check:neutral` | OK |
| `npm run check:architecture` | OK |
| Credentials present | LLM: Ollama configured but not running; **no** telephony, STT, TTS or embedding credentials |
| Docker / psql | available (for `check:migrations`, `check:rls`) |

## 2. Target architecture (summary — full detail in `docs/VOICE_ARCHITECTURE.md`)

```text
Telephony provider ──webhook──▶ services/voice-gateway (HTTP: verify signature → resolve number → stream token)
        │                                   │
        └──media WS (μ-law 8 kHz)──────────▶ services/voice-gateway (WS: verify stream token)
                                            │  provider media codec (adapter)  ← provider events stay here
                                            ▼
                               packages/voice  VoiceGateway  (startSession/receiveAudio/receiveEvent/
                                            │                 sendAudio/interrupt/endSession/handleProviderEvent)
                                            ├─ CallStateMachine (technical state, terminal protection)
                                            ├─ VoiceSession     (listening/user_speaking/thinking/speaking;
                                            │                    barge-in, cancellation, silence, watchdog)
                                            ├─ Endpointer/VAD, bounded audio queues, sentence chunker
                                            ├─ CallEvents + latency marks + usage   ← internal domain events
                                            ▼
                               VoiceTurnHandler port ──▶ phone channel adapter ──▶ packages/runtime AgentRuntime
                                            │                                        (UNCHANGED loop; +AbortSignal)
                                            ▼
                               StreamingSttProvider / StreamingTtsProvider / TelephonyProvider ports
                               (fakes in packages/providers/voice-fakes; reference media-stream adapter)
```

## 3. Checklist

Columns: **ID · Objective · Files/packages · Depends · Validation · Status · Evidence**.

### Phase 3 — Voice foundation

| ID | Objective | Files / packages | Depends | Validation | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| P3-00 | Recon, baseline gates, scope reconciliation, this plan | `docs/PHASE3_PHASE4_EXECUTION_PLAN.md` | — | gates in §1 | COMPLETE | §0, §1 |
| P3-01 | Provider-neutral voice contracts: telephony (control + media codec + `verifyWebhook` mandatory), streaming STT, streaming TTS (cancellable); voice domain types (direction, call state, dispositions, call event types) | `packages/ports/{telephony,streaming-stt,streaming-tts}-provider.ts`, `packages/core/domain/voice.ts` | P3-00 | tsc, eslint, check:architecture | MOCK-VERIFIED | `packages/ports/{telephony,streaming-stt,streaming-tts}-provider.ts`, `core/domain/voice.ts`; tsc + lint + check:architecture green |
| P3-02 | Technical call state machine with explicit `assertCallTransition`, terminal protection, inbound skips dial states | `packages/voice/call-state.ts`, `tests/unit/voice/call-state.test.ts` | P3-01 | vitest | MOCK-VERIFIED | `call-state.ts`; `call-state.test.ts` + `call-state-sql-parity.test.ts` |
| P3-03 | Audio primitives: G.711 μ-law ↔ PCM16, frame chunking, bounded audio queue (drop-oldest + counter), energy VAD/endpointer (speech start, end-of-speech hangover, min speech) | `packages/voice/audio.ts`, `packages/voice/endpointer.ts`, tests | P3-01 | vitest (golden codec vectors, synthetic frames) | MOCK-VERIFIED | `audio.ts`, `endpointer.ts`; golden μ-law vectors, bounded-queue and VAD tests |
| P3-04 | Voice session state machine: turn generations, barge-in (idempotent interrupt), abort in-flight runtime + TTS, silence budget → reprompt → graceful close, watchdog, bounded utterance/turn queue, STT reconnect-once | `packages/voice/voice-session.ts`, tests | P3-02, P3-03 | vitest with fake clock | MOCK-VERIFIED | `voice-session.ts`; 25 unit tests. Hardened 2026-09-21 — `PHASE3_REPORT.md` §5.1–5.2 |
| P3-05 | Deterministic fakes (scripted STT, scripted/cancellable TTS, fake telephony) + reusable provider contract test kit | `packages/providers/voice-fakes/*`, `tests/contracts/*` | P3-01 | vitest contract suites | MOCK-VERIFIED | `packages/providers/voice-fakes/*`; `tests/contracts/voice-provider-contracts.ts` |
| P3-06 | Runtime integration: `phone-voice` ChannelProfile; additive `RuntimeInput.signal` cancellation (no persistence after abort); phone channel adapter (`VoiceTurnHandler`) with deferred assistant-row flush marking delivered / interrupted-partial; sentence chunker | `packages/runtime/{contracts,channel-profile,agent-runtime,llm-adapter}.ts`, `packages/voice/{turn-handler,sentence-chunker}.ts`, tests | P3-04 | vitest (all 565 prior tests unchanged + new) | MOCK-VERIFIED | `phone-channel-adapter.ts`, `turn-handler.ts`, `sentence-chunker.ts`; `voice-runtime.test.ts` |
| P3-07 | Migration `0020_voice_calls.sql`: `phone_numbers`, `calls`, `call_events`, `call_transcript_turns`, `conversation_outcomes`; `conversations.channel += 'phone'` (receptionist optional only for phone); `usage_events` types; call-state transition trigger (terminal protection in Postgres); RLS in the same migration | `supabase/migrations/0020_voice_calls.sql`, `scripts/check-migrations.mjs`, `scripts/check-rls.mjs` | P3-02 | `check:migrations`, `check:rls` on fresh pgvector PG16 | MOCK-VERIFIED | `0020_voice_calls.sql`; `check:migrations` + `check:rls` PASS on a fresh pgvector PG16 |
| P3-08 | Call persistence: `CallStore` port; Supabase store (idempotent on `(provider, provider_call_id)` and `(call_id, seq)`); in-memory store for tests; server-side number → tenant/agent/version resolution | `packages/voice/call-store.ts`, `packages/voice/stores/supabase-call-store.ts`, `tests/mocks/in-memory-call-store.ts` | P3-07 | vitest; check:rls | MOCK-VERIFIED | `call-store.ts`, `supabase-call-store.ts`, `in-memory-call-store.ts`; concurrent-upsert test added 2026-09-21 |
| P3-09 | `VoiceGateway`: `startSession / receiveAudio / receiveEvent / sendAudio / interrupt / endSession / handleProviderEvent`; bounded session registry; correlation ids; per-stage latency marks; usage; outcome finalization on every terminal path; human-handoff boundary (transfer only to tenant-configured target) | `packages/voice/gateway.ts`, tests | P3-04..P3-08 | vitest integration (connect → turns → hangup; failures) | MOCK-VERIFIED | `gateway.ts`; 14 integration tests. Single-flight fix 2026-09-21 — `PHASE3_REPORT.md` §5.3 |
| P3-10 | Reference media-stream telephony adapter (Twilio-Media-Streams-compatible JSON/base64 μ-law protocol; HMAC-SHA1 webhook signature, fail closed) — vendor choice remains open (§P4) | `packages/providers/telephony/media-stream-*.ts`, tests with documented fixtures | P3-05 | contract kit + signature tests | MOCK-VERIFIED | `providers/telephony/twilio-media-stream-provider.ts`; `twilio-media-stream.contract.test.ts` |
| P3-11 | `services/voice-gateway` long-lived process: HTTP inbound webhook → connect instructions with signed short-lived stream token; WS media endpoint; token verification; graceful shutdown; health; config fails closed | `services/voice-gateway/*`, `package.json` (`ws`) | P3-09, P3-10 | integration test over a real local WebSocket with fakes | MOCK-VERIFIED | `services/voice-gateway/*`; `voice-gateway-service.test.ts` over a real local WebSocket |
| P3-12 | Failure/disconnect suite (STT drop, TTS drop, LLM timeout, provider disconnect, hangup mid-tool); latency harness with mock timings; docs | `tests/integration/voice-*.test.ts`, `scripts/voice-latency-harness.ts`, `docs/VOICE_ARCHITECTURE.md`, `docs/PHASE3_REPORT.md` | P3-11 | vitest; harness output recorded | MOCK-VERIFIED | `tests/integration/voice-*.test.ts`; `npm run voice:latency` in `VOICE_LATENCY_MODEL.md` |
| P3-13 | Live provider smoke test (real PSTN inbound, STT, TTS, barge-in, termination; latency p50/p95) | runbook procedure only | credentials | manual procedure in runbook | BLOCKED | no telephony/STT/TTS credentials |

### Phase 4 — Telugu-first Arunodhaya demo

| ID | Objective | Files / packages | Depends | Validation | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| P4-01 | `packages/language`: NFC + ZWJ/ZWNJ-for-matching normalization, Telugu/Devanagari digit folding, script-based language detection (te / en / te-en code-switch, confidence), `LanguagePack` registry with loud downgrade for unsupported languages | `packages/language/*` | — | vitest corpora | MOCK-VERIFIED | `call-store.ts`, `supabase-call-store.ts`; concurrent-upsert test added |
| P4-02 | Deterministic parsers with test corpora first: numerals (Telugu script, romanized, English, Indian grouping, lakh/crore, "2k"), money (₹/Rs/రూపాయలు), energy units vs amount disambiguation, capacity (kW/"kv" ASR error/కిలోవాట్), Indian mobile numbers (incl. spoken digit words, "double"), pincode, names (original preserved, honorifics stripped only for matching), affirm/deny/human-request/do-not-call/repeat lexicons | `packages/language/parsers/*` | P4-01 | vitest | MOCK-VERIFIED | `gateway.ts`; 14 integration tests. Single-flight fix 2026-09-21 |
| P4-03 | Generic qualification engine: zod schema (field types, ordered per-language questions, confirm-back, disqualifiers, clarification + max attempts → escalation), deterministic extraction bound to the pending question, raw utterance kept beside normalized value; runtime `SystemActionProvider` supplying ground truth | `packages/qualification/*` | P4-02, P3-06 | vitest | MOCK-VERIFIED | `twilio-media-stream-provider.ts`; signature + codec contract tests |
| P4-04 | Deterministic disposition/outcome computation (§P5.4) incl. DNC suppression, separate from call state | `packages/qualification/disposition.ts` | P4-03 | vitest | MOCK-VERIFIED | `services/voice-gateway/*`; real local WebSocket integration test |
| P4-05 | Site-visit booking step through the EXISTING `BookingService` (slot offer, Telugu/Tenglish slot selection, idempotent booking key, typed `slot_taken` alternatives, never narrated before success) | `packages/qualification/booking-step.ts` + app adapter | P4-03 | vitest with in-memory scheduling | MOCK-VERIFIED | `tests/integration/voice-*.test.ts`; `npm run voice:latency` recorded |
| P4-06 | Telugu/Tenglish time expressions (రేపు, ఎల్లుండి, weekdays, ఉదయం/సాయంత్రం) normalized for the existing `when-parser` | `packages/language/parsers/time-expressions.ts` | P4-01 | vitest | TODO | |
| P4-07 | Arunodhaya configuration (outside `packages/`): tenant, agent identity/objective, Telugu prompt template, voice settings, qualification schema, allowed tools, knowledge sources (⟨SUPPLIED⟩ placeholders only), appointment rules, escalation rules, outcome categories, agent version | `src/content/tenants/arunodhaya/*` | P4-03..P4-06 | vitest (config parses; no fabricated price/subsidy/timeline numbers) | TODO | |
| P4-08 | Reproducible, resettable demo: idempotent seed + reset scoped to the demo tenant slug; refuses non-local DB without explicit flag | `scripts/demo/arunodhaya-{seed,reset}.ts` | P3-07, P4-07 | run against docker PG; re-run idempotent | TODO | |
| P4-09 | Golden Telugu/Tenglish call suites through the gateway with fakes: happy path, code-switching, silence, barge-in, misrecognition/low confidence, repeated answers, disqualifier, DNC, escalation, provider failure (no false success), disconnect mid-turn still yields outcome | `tests/integration/arunodhaya-*.test.ts` | P3-09, P4-07 | vitest + snapshots | TODO | |
| P4-10 | Mock demo runner, runbook, reports, limitations | `scripts/demo/arunodhaya-simulate.ts`, `docs/{ARUNODHAYA_DEMO_RUNBOOK,PHASE4_REPORT,KNOWN_LIMITATIONS}.md` | P4-09 | runner output recorded | TODO | |
| P4-11 | Multilingual retrieval (§P3.2–P3.5: embedding bake-off, 1024-dim model-tagged embeddings, simple/trigram FTS, ≥200-query native eval set) | — | decision memo 0001, native reviewers | — | BLOCKED | no embedding decision, no native eval set |
| P4-12 | Real Telugu STT/TTS quality, native-speaker scoring, ≥20 scored live calls | — | credentials, native panel | — | BLOCKED | |

### Cross-cutting

| ID | Objective | Validation | Status | Evidence |
| --- | --- | --- | --- | --- |
| X-01 | Full regression after every batch | tsc, eslint, vitest, build, preflight:ci, check:neutral, check:architecture, check:migrations, check:rls | DONE | All green 2026-09-21; 782 tests (baseline 774) |
| X-02 | Logical commits per coherent validated batch (no push) | `git log` | DONE | `fb5de62`, `ec856db`, `adc1089` (not pushed) |
| X-03 | Update ARCHITECTURE/RUNTIME/SECURITY/TESTING/CHANGELOG/packages README + memory | doc review | PARTIAL | VOICE_* docs + PHASE3_REPORT/BASELINE written; CHANGELOG/README not yet |

## 4. Commit plan

1. docs: execution plan (this file)
2. voice contracts + domain model + call state machine + audio primitives
3. voice session + fakes + contract kit
4. runtime integration (phone profile, cancellation, turn handler)
5. calls data model + stores + gateway
6. reference telephony adapter + voice-gateway service
7. language packs + Telugu parsers
8. qualification engine + booking step + dispositions
9. Arunodhaya configuration, seed/reset, golden suites, demo runner
10. reports, runbook, limitations

## 5. Log (failures, resolutions, risks)

_Appended as work proceeds._

### 2026-09-21 — Phase 3 verification and hardening

The P3-01..P3-12 rows above had been left at `TODO` although the work landed in
commits `df5f7b9`..`45ab83e`. Corrected to MOCK-VERIFIED after auditing each
against source and tests. **Documentation was stale, not the code.**

Three real defects were found by probe tests during that audit, each reproduced
before being fixed (detail in `docs/PHASE3_REPORT.md` §5):

1. the human-handoff window was not serialized, so caller speech during a bridge
   started a new runtime turn — able to commit a business action for a caller
   already being transferred (`fb5de62`);
2. `play()` allowed two concurrent playbacks to share the media socket, the
   watchdog slot and each other's transcript rows (`fb5de62`);
3. `startSession` had a check-then-act window that produced two sessions, two
   call rows and two conversations for one provider call (`ec856db`).

Also: the phone channel was inheriting the web-chat context budget; it now has
its own, measured at a 47.8% context reduction (`adc1089`).

Risk noted, deliberately not changed: a stream token replayed inside its TTL can
reattach and redirect call audio. Restricting it needs evidence about real
provider reconnect behavior. See `docs/PHASE3_REPORT.md` §10.
