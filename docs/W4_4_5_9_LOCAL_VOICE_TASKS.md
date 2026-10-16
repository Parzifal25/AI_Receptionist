# W4.4 / W4.5 / W4.9 — remaining local voice levers

Owner authority: Autonomous Phase 2 Completion Loop; existing implementation-plan
cards W4.4, W4.5 and W4.9. Each card is implemented/tested/reviewed separately.
No provider/model selection, migration, paid call or hosted action is authorized.

## W4.4 — parallel reads and call-scoped reuse

Problem/baseline: AgentRuntime waits for state before loading history. Phone turns
reload both even though one serialized session owns its state and delivery history.
Scope: runtime read scheduling, phone adapter, a pinned tenant/conversation cache,
regression and synthetic benchmark. Knowledge stays per-turn and revocation-aware;
no knowledge/version/policy caching. No global/cross-call cache. Acceptance: parallel
independent reads; bounded local history/state reuse after successful persistence;
no cross-tenant access, mutation aliasing or cache success after a failed write;
existing turn budgets, cancellation, delivery/handoff invariants unchanged. Commands:
focused runtime/phone tests, synthetic benchmark, full JS/worker and canonical gates.
Rollback: reverse this card's diff, restoring sequential uncached reads.

## W4.5 — ordered asynchronous transcript/state persistence

Problem/baseline: post-reply transcript/state writes delay validated phone replies.
Scope: per-call bounded ordered queue behind explicit voice-only adapters; delivery
accounting remains in DeferredAssistantStore. Tool audit and business/provider
mutations remain synchronous; this queue never proves a booking or delivery.
Acceptance: measured fake-storage delay removed from reply path, preserved ordering,
commit-point cancellation and delivery truth; failed/ambiguous writes never replay;
close drains or reports pending work within a bounded wait. No unbounded queue,
shared tenant cache or silent durable-success claim. Test failures, hung storage,
queue bounds, clone ownership and next-turn history explicitly. Rollback: synchronous
voice persistence wiring. Crash durability limitations must remain visible.

## W4.9 — startup sockets, fixed policy audio and wire format

Problem/baseline: inspect pinned Pipecat service startup and codec handling before
changing anything. Scope: worker configuration and bounded tenant+voice+language
policy-audio cache only if the current service framing supports faithful replay;
never cache user/model content, action confirmations or audio across scopes.
Acceptance: synthetic no-cross-call/tenant/audio tests; measurable eliminated work;
no provider-default model choice or inaccurate PCM/μ-law frame labels. Preconnect
must use existing per-call startup ownership and cleanup. Provider wire-format
support and real cost/latency remain D17/target validation; unsupported changes
are documented rather than guessed. Rollback: bypass cache/restore codec settings.

Artifacts/results: PHASE2_COMPLETION_REVIEW.md and the existing verification ledger.

W4.4 manual review: corrected a short-circuit regression before proceeding — a
hung parallel history read must not delay an exhausted turn-budget rejection.
Both read failures are observed immediately; the state/budget decision remains
first. Four focused cache/read tests, existing cancellation and phone integration
contracts pass; typecheck/lint/architecture pass. Ten sequential benchmark samples
(after two warmups per mode, 20 ms injected per read) measured p50 turn wall
43.52 ms serial control, 22.64 ms parallel and 1.52 ms warm call reuse. The
serial control models the former dependency, rather than claiming a second build
of historical code. Knowledge continues to be resolved on every turn.


Final status: **LOCALLY COMPLETE / HOSTED VERIFICATION PENDING** for all three.
W4.5: 64 pending writes, FIFO/no ambiguous retry, bounded 5s close. Queue admission
is explicitly not durability; crash/full-queue transcript/state loss is a known
tradeoff. Critical audit and action mutations remain synchronous. Five new queue
and runtime integration cases pass. Synthetic two-write benchmark p50 43.71ms
awaited vs 1.25ms queued. Rollback removes queue wiring and awaits cache writes.

W4.9: existing per-call SDK startup preconnect retained; no duplicate connect.
Policy-only call-local LRU is bounded to 4 entries/512KB with tenant/agent/voice/
language/rate scoping and fallback/close invalidation. Nine tests pass, including
early cancellation, cache isolation, pinned codec settings and bit-exact wire
conversion. Ten fake-synthesis samples measured p50 miss31.425ms/hit1.764ms.
Twenty serializer samples measured PCM11.15ms vs μ-law0.116ms (p50 CPU only).
Default linear16 path/service class preserved; μ-law opt-in is not activated.
Real provider codec/audio quality, quotas and Telugu caller latency require D17
and target-specific authorization. Rollback bypasses cache and leaves codec unset.

Final source/manual review checked hung-history budget rejection, clone ownership,
queue failure/order/close, heard-only context, fresh cached replay marks, late audio,
fallback partial captures, codec defaults and startup cleanup. Full suites and
exact commands are linked in the completion report/verification ledger.

Reproduction (synthetic inputs, no provider access):
```bash
npx vitest run tests/unit/voice/call-context-cache.test.ts tests/unit/voice/ordered-persistence.test.ts tests/integration/voice-async-persistence.test.ts
node --import tsx scripts/voice-context-benchmark.ts
node --import tsx scripts/voice-persistence-benchmark.ts
node --import tsx scripts/voice-cooldown-benchmark.ts
.venv/bin/python -m unittest discover -s services/pipecat-worker -p test_policy_audio_cache.py
.venv/bin/python services/pipecat-worker/benchmark_policy_cache.py
```
Use synthetic environment/network isolation as in the verification ledger. Full
JS/worker suites, typecheck, lint, architecture/neutrality and preflight are the
required combined gates. No schema changes; disposable DB gates were rerun as
part of overall release verification.

Fresh final review correction: timed-out state reads now use a revision guard so
late snapshots cannot replace newer call-owned saves. Fifth cache test covers
this failure path; full gates/build rerun after the fix. Existing benchmark is a
synthetic stage comparison, not a durable-storage or provider latency guarantee.
