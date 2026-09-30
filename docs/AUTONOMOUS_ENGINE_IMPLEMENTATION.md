# Autonomous employee engine — audit and implementation plan

Started 2026-09-29. Audit re-done from source on 2026-09-29 (docs such as
`CURRENT_STATE_AUDIT.md`, dated 2026-09-02, lag the code and were not trusted).

Rule for this work: extend the modular monolith. No new service for business
logic, no rewrite of the runtime, voice session, tool boundary, workflow engine
or agent versioning. Nothing tenant-specific in `packages/` (`check:neutral`).

## 1. Architecture map (as built)

```
telephony ─▶ services/voice-gateway ─▶ packages/voice/gateway.ts ──┐
              (only separate process)    route: number→tenant→agent  │ pins agent_version_id
Pipecat worker (python, NOT VERIFIED) ◀─ pipecat/bridge + remote-session (control events, no tenant content)
web widget ─▶ /api/v1/widget/* ─▶ src/core/services/chat-service.ts ─┤
                                                                     ▼
                  packages/runtime/agent-runtime.ts  (HALO is the orchestrator)
   state store → knowledge resolver → SystemActionProviders (qualification,
   negotiation, booking step, tenant guidance) → selectTools (closed registry)
   → context-builder (char + script-aware token budget) → prompt-composer
   → bounded model/tool loop (≤2 tool rounds, ≤3 intents/round, idempotency,
     confirmation state machine) → response-validator (act-then-narrate,
     repair once, safe fallback) → SafeSpeechStream (held/release/retract)
   → escalation-manager → memory-manager (rolling recap) → persist → hooks
                                                                     │
   packages/providers/llm: ollama · anthropic · gemini · openai-compatible
   (groq, openrouter) · FallbackLLMRouter (cooldowns, billing limits)
   packages/qualification · negotiation · scheduling · crm · workflows ·
   lifecycle · language · agents (immutable versions) · tenancy
   supabase/migrations 0001–0023 (RLS; calls, call_events, outcomes, suppression)
```

## 2. Status by capability (before this work)

| Capability | Status | Evidence |
| --- | --- | --- |
| Tenant → agent → immutable version, pinned per call/conversation | VERIFIED (tests) | `packages/agents/*`, `0013`–`0018`, runtime tenant/version mismatch guards |
| Bounded tool loop, closed registry, authorization, idempotency | VERIFIED (tests) | `runtime/tools/*`, `agent-runtime.ts` |
| Act-then-narrate (incl. tenant-language claim phrases) | VERIFIED (tests) | `response-validator.ts`, guardrails.actionClaimPhrases |
| Safe streaming into speech, barge-in, stale playback | MOCK-VERIFIED | `speech-stream.ts`, `voice-session.ts` |
| Qualification (schema-driven, next missing field) | MOCK-VERIFIED | `packages/qualification` |
| Negotiation within policy, concession re-check at execution | MOCK-VERIFIED | `packages/negotiation` |
| Appointment booking (DB exclusion constraint) | VERIFIED (tests) | `packages/scheduling` |
| Workflows (idempotent runs, retries, timers) | VERIFIED (tests) | `packages/workflows` |
| CRM dedupe/merge, forward-only stage | VERIFIED (tests) | `packages/crm/crm-service.ts` (5 coarse stages) |
| Script-aware token estimate + budget | VERIFIED as estimate | `language/tokens.ts`, `runtime/token-budget.ts` |
| LLM failover with cooldown / billing-limit | MOCK-VERIFIED | `fallback-router.ts` |
| Sarvam STT/TTS adapters | IMPLEMENTED, live use BLOCKED | no credentials / audio stack here |
| Pipecat worker | NOT VERIFIED | never run against real media |
| Golden conversations | MOCK-VERIFIED, single tenant | `tests/golden/arunodhaya` (ScriptedLLM) |

## 3. Uncommitted work found at start (previous session)

- `ComplexityLLMRouter` + `HALO_MODEL_ROUTES` (tier → ordered candidates, shared
  cooldowns), `routingTier` on the LLM port, `classifyTurn` in the runtime.
- Cached-input-token passthrough from OpenAI-compatible usage.
- Incomplete-stream rejection in `llm-adapter.consumeStream`.
- Version-pinned sales config (`sales-config.ts`) and production binding of
  `SalesCallAssembly` in the gateway, existing-caller preload, booking adapter,
  DNC suppression hook, outbound-aware DNC number, `onOutcome` CRM upsert.

Review findings on it, to fix before committing:
1. `classifyTurn` hard-codes an English/Telugu/Tenglish lexicon in the core and
   ignores state (pending confirmation, active negotiation). Lexicon-only
   guards silently stop working for other languages; cues must come from
   configuration, and state signals must count.
2. `ComplexityLLMRouter.isHealthy` checks only the medium tier.
3. Gateway wiring has no test yet.

## 4. Missing capabilities

| # | Gap | Current state |
| --- | --- | --- |
| G1 | Outbound campaign engine (eligibility, window, DNC, attempts, retry, stop) | NOT IMPLEMENTED; `TelephonyCapabilities.outbound` flag only, no dial method |
| G2 | Deterministic lead lifecycle (NEW…WON + terminal states) | PARTIAL: CRM has lead/engaged/booked/customer/lost |
| G3 | Outcome → follow-up policy (callback, reminder, retry) | PARTIAL: workflow timers exist, nothing decides |
| G4 | Complexity routing configurable per agent, state-aware | PARTIAL (WIP) |
| G5 | Relevant-tool selection per turn | NOT IMPLEMENTED: all granted+bound tools every turn |
| G6 | Per-layer token telemetry (system/state/conversation/knowledge/tool), cached tokens | PARTIAL: whole-prompt estimate + provider totals |
| G7 | Stable-prefix prompt ordering for native provider caching | NOT IMPLEMENTED |
| G8 | Per-agent cost guardrails (max turns, max conversation tokens) | PARTIAL: global runtime policy, call duration only |
| G9 | Turn-level voice profile by language (speaker, pace, sample rate) | NOT IMPLEMENTED: one voice per version |
| G10 | STT/TTS fallback chain (self-hosted IndicConformer / IndicF5) | NOT IMPLEMENTED; live validation BLOCKED |
| G11 | Controlled learning (proposal → human review → new draft version) | NOT IMPLEMENTED (eval harness exists) |
| G12 | Business-agnostic demo tenants + multi-domain golden tests | NOT IMPLEMENTED |
| G13 | Runtime events reach `call_events` from the gateway | NOT IMPLEMENTED (logs only) |

## 5. Reuse, do not rewrite

Runtime loop, tool boundary, validator, SafeSpeechStream, voice session
invariants, Pipecat boundary, qualification/negotiation providers, booking
service, workflow engine + timers, CRM service, agent versioning, token
estimator, FallbackLLMRouter, call store and suppression list.

## 6. Order of implementation (each phase: typecheck, lint, tests, architecture,
neutrality; one small commit per phase; no push)

- **A** Finish WIP: configurable + state-aware tier classifier, all-tier health,
  gateway wiring tests. (G4)
- **B** Lead lifecycle state machine in `packages/crm`, fed by dispositions and
  verified actions only. (G2)
- **C** Campaign engine `packages/campaigns`: pure eligibility/retry policy,
  store port + in-memory + migration with RLS, dispatcher over an optional
  `dial` on the telephony port. (G1)
- **D** Follow-up policy: outcome → idempotent workflow timer. (G3)
- **E** Token work: relevant-tool selection, per-layer accounting, stable-first
  prompt order (composer version bump), per-agent limits. (G5–G8)
- **F** Voice: per-language voice profiles, turn-level selection, STT/TTS
  fallback wrappers, self-hosted adapters (NOT VERIFIED). (G9, G10)
- **G** Generic demo tenants (home services, solar, education) and golden
  conversations in English / Telugu / Tenglish. (G12)
- **H** Controlled learning proposals. (G11)
- **I** Telemetry wiring + p50/p95 report; full suite; final report. (G13)

## 7. Risks

- Real providers, telephony, audio and Telugu quality stay BLOCKED here; every
  latency/token figure from this work is mock or estimate unless it says otherwise.
- `check:rls` / `check:migrations` need Postgres on :54322.
- Reordering the prompt changes snapshots and the golden corpus; it must be
  pinned by tests showing content is unchanged, only order.
- Sample rate: the brief says 22000 Hz. Sarvam documents 22050 Hz. This is
  configuration, so it stays a tenant value and is flagged, not guessed.
- Environment note: the sandbox's shell permission check intermittently
  failed on 2026-09-29, which blocked running the baseline suite at audit time.

Initial sandbox test run (previous session): 105 files passed; 3 socket
integration files failed with `listen EPERM` (sandbox, not code).
