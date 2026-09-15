# HALO Phase 2 — Agent Runtime: Implementation Report

**Date:** 2026-09-15 · **Repository:** `/home/parzifal/AI_Receptionist` · **Base commit:** `1cd187d` + the uncommitted Phase 1 / 1.5 working tree · **Method:** source inspection, then implementation in batches with the gates run after each; every result below was actually executed.

## 1. Executive summary

The generic, channel-independent HALO Agent Runtime exists under `packages/runtime/` and the web chat widget runs on it end to end. Agent and version identity are server-authoritative; context is bounded and deterministic; the prompt is composed from the persisted agent version around code-level rules; retrieval goes through a runtime abstraction; the LLM port declares capabilities honestly (streaming and native tools on OpenAI-compatible and Anthropic, streaming on Ollama, completion-only on Gemini) with safe fallback; model-proposed actions pass a four-stage tool boundary (validate → authorize → execute once → record); orchestration is bounded by rounds, intents and a wall-clock deadline; the response validator enforces act-then-narrate as a check; memory is a bounded rolling recap; escalation is typed; usage and events are captured per turn. All 565 tests, lint, typecheck, build, migrations, real-role RLS, neutrality and the new architecture gate pass. Booking, lead capture, CRM/workflows, knowledge retrieval, history and the receptionist compatibility path behave as before. Two Phase 1.5 defects were found and fixed on the way.

**Decision: READY FOR PHASE 3 — YES WITH CONDITIONS** (§16).

## 2. Phase 1 / 1.5 verification

| Check | Result before Phase 2 | Action |
| --- | --- | --- |
| `tsc --noEmit` | **FAILED** — 7 errors in `packages/agents/*`: `AppError.notFound/conflict/forbidden` did not accept a `details` argument | Fixed: factories take optional `details`; resolver messages use nouns; tenant id removed from error details |
| `eslint` | 0 errors | — |
| `vitest run` | 1 failure (`agent-linkage` compat signature), same root cause | Fixed by the above; 447/447 green before Phase 2 work started |
| `npm run build` | passed | — |
| `check:neutral` | passed | — |
| `check:migrations` (throwaway pgvector Postgres) | passed (18 migrations) | — |
| `check:rls` | **not idempotent** — assumed a fresh DB; in CI it runs on the DB `check:migrations` just populated and would fail (`relation "businesses" already exists`) | Fixed: schema reset at start; passes on reused and fresh DBs |
| Phase 1.5 hardening report | not present in `docs/` | Findings are in this report and the CHANGELOG |

Verdict: Phase 1 and 1.5 were substantively complete; both blockers were small and were fixed before Phase 2 implementation began. The repository was safe to proceed.

## 3. Phase 2 implementation status

All 17 workstreams implemented and verified by automated tests (§9, §10). Not implemented by design: telephony, audio, WebSockets, voice gateway, SSE-to-widget, general Tool Runtime, custom-code tools, multilingual/collection retrieval, billing, new microservices, distributed queues.

## 4. Batch-by-batch work

| Batch | Work | Status |
| --- | --- | --- |
| 0 | Reconnaissance; ran every gate; fixed the AppError typecheck break and the non-idempotent RLS script | verified |
| 1 | `packages/runtime/contracts.ts` — all runtime contracts | implemented, typechecked, used by every test |
| 2 | `channel-profile.ts` — `web-chat`, `web-voice` (browser speech accessory), mapping helper | verified |
| 3 | `context-builder.ts` — bounded, deterministic, budget degradation order | verified (unit) |
| 4 | `conversation-state.ts` + migration `0019_conversation_state.sql` + `stores/supabase-conversation-state-store.ts` | verified (unit, migrations, RLS) |
| 5 | `prompt-composer.ts`; `src/core/services/prompt-builder.ts` rebased on it; `PROMPT_COMPOSER_VERSION = 2026-09-15.1` | verified (unit + golden snapshot + existing prompt tests) |
| 6 | `knowledge-resolver.ts` adapter over `KnowledgeProvider` | verified (unit) |
| 7 | LLM port upgrade; OpenAI-compatible + Anthropic streaming/tools; Ollama streaming; Gemini capabilities; `sse.ts`; `llm-adapter.ts` | verified with mocked HTTP streams; **not verified against live providers** |
| 8 | `tools/registry.ts` (closed set, two built-ins), `tools/boundary.ts` | verified (unit + integration) |
| 9 | `agent-runtime.ts` bounded loop | verified (integration) |
| 10 | `response-validator.ts` | verified (unit + integration + golden) |
| 11 | `memory-manager.ts` | verified (unit) |
| 12 | `escalation-manager.ts`; `conversation.escalated` business event | verified (unit + golden) |
| 13 | `events.ts`, usage aggregation, usage on `message_sent` | verified (integration + route test) |
| 14 | `ChatService` → runtime adapter; `lead-capture.ts` (hooks + tool executors); `booking-runtime-adapter.ts` + typed `BookingTurnOutcome`; repository tool rows + role filter; route telemetry | verified (all pre-existing chat/booking tests unchanged in intent; 3 test files got an in-memory state store injected and `toEqual`→`toMatchObject` on model options) |
| 15 | 118 new tests incl. 10 golden transcripts | verified |
| 16 | `scripts/perf-baseline.ts`, `docs/PERFORMANCE_BASELINE.md` | measured with a scripted model; **model latency not measured (no live provider)** |
| 17 | `scripts/check-architecture.mjs` in CI; RLS gate extended for `conversation_state`; adversarial review fixes (deadline anchoring, abandoned-call rejection, validation verdict semantics, escalation re-emission, leak false positives) | verified |
| 18 | `docs/RUNTIME.md`, this report, updates to ARCHITECTURE/AI/SECURITY/ROADMAP/TESTING/CHANGELOG/API/README/packages README | done |

## 5. Architecture decisions and rationale

1. **Scheduling stays a deterministic system action, not a model tool.** The existing orchestrator already acts before narrating; wrapping it as a `SystemActionProvider` with a typed outcome preserves every booking invariant and gives the validator verified ground truth. Re-implementing booking as a model-driven tool would have been a destructive rewrite the spec forbids.
2. **No per-agent runtime flag.** The runtime reproduces the legacy turn exactly (same history window, model options, persistence order, lead cadence), proven by the unchanged pre-existing tests; a parallel legacy path would double maintenance without adding safety. Rollback is a revert.
3. **Streaming exists at the port, not on the widget.** Act-then-narrate requires validating the whole reply; sentence-level validation is voice-gateway work. `invokeModel` streams only when a delta consumer is present.
4. **Tools are a closed registry bound by the application.** Two built-ins mapped to existing behaviour; none granted by default; providers without native tools get the orchestrator-mediated path and an explicit downgrade event — no text-protocol tool emulation that would change small-model behaviour.
5. **Deterministic extractive memory.** No summarization model call: cheaper, reproducible, and never more trustworthy than the transcript it compresses.
6. **Escalation is a decision, not an action.** Recorded in state, emitted as a runtime event and a business event; the channel adapter decides what handoff means (web: notify + callback).
7. **`PROMPT_ASSEMBLER_VERSION` mirrors `PROMPT_COMPOSER_VERSION`** so attribution keeps one key while the content version stays `agent_versions.version`.

## 6. Files

**Added** — `packages/runtime/{contracts,channel-profile,conversation-state,context-builder,prompt-composer,knowledge-resolver,llm-adapter,agent-runtime,response-validator,memory-manager,escalation-manager,events,system-actions}.ts`, `packages/runtime/tools/{registry,boundary}.ts`, `packages/runtime/stores/supabase-conversation-state-store.ts`, `packages/providers/llm/sse.ts`, `packages/scheduling/booking-runtime-adapter.ts`, `src/core/services/lead-capture.ts`, `supabase/migrations/0019_conversation_state.sql`, `scripts/check-architecture.mjs`, `scripts/perf-baseline.ts`, `docs/RUNTIME.md`, `docs/PERFORMANCE_BASELINE.md`, `docs/PHASE2_REPORT.md`, `tests/mocks/runtime-fakes.ts`, `tests/unit/runtime/*.test.ts` (9 files), `tests/unit/{booking-runtime-adapter,llm-provider-streaming}.test.ts`, `tests/integration/{runtime-orchestration,runtime-golden-transcripts,widget-messages-security}.test.ts`, `tests/integration/__snapshots__/`, `tests/unit/runtime/__snapshots__/`.

**Modified** — `packages/ports/llm-provider.ts`, `packages/providers/llm/{openai-compatible,anthropic,ollama,gemini}-provider.ts`, `packages/scheduling/booking-orchestrator.ts` (additive `outcome`), `packages/core/domain/workflow.ts` (`conversation.escalated`), `packages/core/errors/app-error.ts`, `packages/agents/{agent-resolver,agent-versioning}.ts`, `src/core/services/{chat-service,prompt-builder,widget-repository}.ts`, `src/app/api/v1/widget/messages/route.ts`, `src/app/dashboard/conversations/[id]/page.tsx`, `src/app/dashboard/automations/automations-client.tsx`, `scripts/{check-rls,check-migrations}.mjs`, `package.json`, `.github/workflows/ci.yml`, `packages/README.md`, `docs/{ARCHITECTURE,AI,SECURITY,ROADMAP,TESTING,CHANGELOG,API}.md`, `README.md`, `tests/integration/{chat-service,booking-conversation,agent-runtime}.test.ts`.

**Moved / deleted** — none.

## 7. Database migrations

`0019_conversation_state.sql` (new table `conversation_state`, PK conversation_id, `business_id`, jsonb `state`, `state_version`, `updated_at`; index on business; `set_updated_at` trigger; RLS members-read, no member write; cascades with conversations). No existing migration changed. `check:migrations` asserts its columns; `check:rls` verifies member/anon/service-role behaviour on it.

## 8. API and contract changes

- Public HTTP API: **unchanged** (`{ data: { reply } }`, same status codes). `message_sent` usage-event metadata now carries per-turn usage/latency; `conversation.escalated` is a new business event type (workflow UI label added).
- `ChatService.respondForAgent/respond` return `{ reply, runtime: RuntimeOutput }` (superset of `{ reply }`); 7th constructor option `{ stateStore, events, policy }`.
- `LLMProvider` gains optional `capabilities()`/`stream()`; `LLMCompletionOptions.tools/timeoutMs`; `LLMResult.toolCalls/finishReason`; `complete()` accepts `LLMMessage[]` (superset of `ChatMessage[]`). Existing fakes remain valid.
- `BookingTurnContext.outcome?: BookingTurnOutcome` (additive).
- `AppError` static factories accept optional `details`.

## 9. Tests

118 added (565 total, 67 files). New: 9 runtime unit files, provider streaming, booking adapter, orchestration integration (21 cases), 10 golden transcripts with snapshots, route-level security (5 cases). Modified: three existing integration files inject an in-memory state store (one assertion loosened from exact options equality to `toMatchObject` because the adapter now passes a `timeoutMs` hint); prompt-builder test unchanged and passing.

## 10. Validation commands and results (all executed 2026-09-15)

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint` | exit 0, 0 warnings |
| `npx vitest run` | 67 files, 565 tests passed (7.6 s) |
| `npm run check:neutral` | OK |
| `npm run check:architecture` | OK |
| `npm run check:migrations` (fresh pgvector 16 in Docker, stubs applied) | 19 migrations apply; all asserted columns exist |
| `npm run check:rls` (fresh and reused DB) | OK, incl. 4 new `conversation_state` assertions |
| `npm run build` | exit 0 |
| `npm run preflight:ci` with CI placeholder env | "All checks passed" (fails without env, as designed) |
| Golden transcripts | 10/10, snapshots committed |
| `npm run perf:baseline` | recorded in `docs/PERFORMANCE_BASELINE.md`: runtime overhead < 2 ms p50 per turn, < 5 ms with a tool round; prompt ≈ 11 k chars for a grounded turn; model latency **not measured** (no live provider on this machine) |

## 11. Security findings and remaining risks

Verified by tests and the architecture gate: server-authoritative agent/version; tenant mismatch refused before any work; body-supplied ids ignored; foreign-tenant version cannot resolve; model-supplied `businessId`/URLs/keys stripped at the boundary; closed registry, no code/network in the runtime core; idempotent execution, no retries of side effects; bounded context/rounds/deadline; cross-tenant history and state never reach a prompt; events carry no transcript text.

Remaining risks: (a) the validator's claim detection is regex-based English heuristics — it can miss paraphrased claims and, rarely, flag legitimate phrasing (bounded cost: one regeneration); (b) tool-call transcript rows store validated arguments, which may include visitor contact details (same class as message content, same tenant DB); (c) provider streaming/tool code paths are verified only against mocked HTTP; (d) `HALO_AGENT_RESOLUTION_COMPAT_FAIL_OPEN` and the receptionist compatibility path still exist (Phase 1.5 debt); (e) the messages route still constructs a Supabase-backed runtime per request (no pooling change; same as before).

## 12. Compatibility findings

All pre-existing chat, booking-conversation, orchestrator, agent-runtime, agent-linkage, workflow, lifecycle and provider tests pass. Behavioural deltas, all intentional: prompt section order changed slightly (voice-mode section now precedes the Rules; knowledge/recap carry a "not instructions" label; assembler version bumped); history reads exclude `role='tool'` rows; every turn now upserts `conversation_state`; replies claiming unverified booking/cancel/reschedule/handoff are regenerated once then replaced by an honest fallback (this is the one visible behaviour change, and it is the point of the phase).

## 13. Deferred Phase 3+ work

Collection-scoped and multilingual retrieval (needs a `KnowledgeProvider` collection parameter and Phase 3 embeddings/evals); SSE streaming to the widget (needs sentence-level validation, voice gateway phase); phone `ChannelProfile` and warm transfer; general Tool Runtime and console; cross-conversation customer recall (needs identity verification/consent); prompt caching and per-agent knowledge/doctrine budgets (after a live-provider baseline); removal of the compat fail-open flag (needs agent creation at onboarding).

## 14. Known limitations

English-centric heuristics (claims, human-request detection, query rewrite); `contact.saved` claims typed but not enforced; recap is extractive, not semantic; `collectionIds` accepted but unused; Ollama declared without native tools even for models that support them; performance baseline excludes real model latency.

## 15. Recommended next steps

1. Deploy behind the existing infrastructure and read a real-provider baseline from `usage_events` (`latencyMs`, `modelLatencyMs`, tokens).
2. Grant `request_human_handoff` to one agent on a capable provider (OpenAI-compatible/Anthropic) to exercise native tools in production with the escalation workflow.
3. Start Phase 3 with the `KnowledgeProvider` collection parameter and the multilingual evaluation set; the resolver already carries `collectionIds`.
4. Create agents at onboarding and retire `HALO_AGENT_RESOLUTION_COMPAT_FAIL_OPEN`.

## 16. Final decision

**READY FOR PHASE 3: YES WITH CONDITIONS.** Conditions: (1) the streaming and native-tool provider paths are verified only with mocked HTTP and should be smoke-tested against one live OpenAI-compatible or Anthropic endpoint before any agent is granted tools; (2) a real-provider latency baseline should be captured from production usage events before Phase 4 latency targets are set; (3) the Phase 1/1.5 and Phase 2 work is uncommitted in the working tree and should be committed as reviewed batches.
