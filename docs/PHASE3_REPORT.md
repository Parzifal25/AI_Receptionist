# HALO Phase 3 — Report

**Date:** 2026-09-21 · **Branch:** `main` · **Baseline:** `docs/PHASE3_BASELINE.md`

Status vocabulary: **IMPLEMENTED** (code exists) · **MOCK-VERIFIED** (tested against
deterministic fakes) · **VERIFIED** (tested against the real thing) · **NOT VERIFIED** ·
**BLOCKED** · **OUT OF SCOPE**.

The phrase "production ready" is not used anywhere in this report, because the
evidence for it does not exist: no component has been exercised against a real
telephony, STT or TTS provider.

---

## 1. Phase 3 status

**Substantially complete and MOCK-VERIFIED. Real-provider validation is BLOCKED.**

Important context: Phase 3 was **largely implemented in prior sessions**
(commits `df5f7b9` → `45ab83e`). The checklist in
`docs/PHASE3_PHASE4_EXECUTION_PLAN.md` still read `TODO` for P3-01..P3-12, which
was stale documentation rather than missing code. This session's contribution was
therefore **verification and hardening**, not construction: auditing the existing
implementation against the Phase 3 requirements, finding and fixing real defects,
and writing the missing design documents.

Three genuine concurrency/latency defects were found, **reproduced with failing
tests**, fixed, and pinned with regression tests. All are described in §5.

## 2. Architecture (as implemented, verified against source)

```text
Telephony provider
      │  webhook (signature-verified, fail closed)
      ▼
services/voice-gateway         ← the only separate process
      │  WSS /media (short-lived HMAC stream token bound to callId+from+to)
      ▼
VoiceGateway (packages/voice/gateway.ts)     session registry, call rows, telemetry
      ▼
VoiceSession (packages/voice/voice-session.ts)   media loop, endpointing, barge-in
      ▼
VoiceTurnHandler ── PhoneTurnHandler (packages/voice/phone-channel-adapter.ts)
      ▼
HALO Agent Runtime (UNCHANGED, channel-independent)
      ▼
Tools / knowledge / conversation state
      ▼
structured reply + deterministic directive → TTS → provider → caller
```

The Agent Runtime is **not** voice-aware. Voice adapts to it through the
`phone-voice` `ChannelProfile` and an additive `RuntimeInput.signal`. Provider
wire formats never cross the adapter boundary: the gateway sees only the neutral
`MediaInboundEvent` union. `npm run check:architecture` enforces these boundaries
and `npm run check:neutral` keeps `packages/` free of tenant-specific logic.

A separate process is justified — not by "voice is involved", but because a
minutes-long stateful bidirectional audio session is the wrong shape for
request/response serverless. Everything else stays in the existing Next.js app.

## 3. Files changed this session

| File | Change |
| --- | --- |
| `packages/voice/voice-session.ts` | `transferring` state; single-playback invariant; `end()` finalization hardening |
| `packages/voice/gateway.ts` | single-flight guard on `startSession` |
| `packages/voice/in-memory-call-store.ts` | atomic check-and-insert (contract parity with the Supabase store) |
| `packages/voice/phone-channel-adapter.ts` | uses the voice context budget |
| `services/voice-gateway/server.ts` | synchronous `starting` latch on the media socket |
| `packages/runtime/context-builder.ts` | `VOICE_CONTEXT_LIMITS` |
| `tests/unit/voice/voice-session.test.ts` | +3 handoff / playback-exclusivity regressions |
| `tests/integration/voice-gateway.test.ts` | +2 duplicate-start regressions |
| `tests/unit/runtime/context-builder.test.ts` | +3 voice-budget regressions |
| `docs/` | BASELINE, STATE_MACHINE, TOKEN_BUDGET, LATENCY_MODEL, this report; ARCHITECTURE updated |

404 insertions across 10 files in three commits, plus documentation. No file was
rewritten and no test was deleted or weakened.

## 4. State machines

Two, deliberately separate (full tables in `docs/VOICE_STATE_MACHINE.md`):

- **Call state** (`created…completed`, 14 states) — the telephony leg. Terminal
  protection enforced **twice**: `assertCallTransition` in TypeScript *and* a
  Postgres trigger in migration 0020, so a replayed provider webhook cannot
  resurrect a finished call even through the service role. A parity test pins the
  TypeScript table against the SQL trigger so they cannot drift.
- **Session state** (`idle → listening ⇄ user_speaking → thinking → speaking →
  transferring → ending → ended`) — the media loop, in-process, not persisted.

Critical lifecycle state is held in these enums plus explicit generation
counters, not in scattered booleans.

## 5. Defects found and fixed (each reproduced before fixing)

### 5.1 Handoff window was not serialized — `fb5de62`

`afterPlayback` awaited the provider transfer while the session sat in
`listening`. Caller speech during the bridge committed an utterance and started a
**new runtime turn**. Reproduced: the caller heard "please hold while I connect
you", then a full answer to a new question, then "I could not connect you".

Worse than incoherent — that turn could execute a **business action for a caller
already being handed to a human**, and a successful transfer's
`end("transferred")` would cut it off mid-action.

Fixed with an explicit `transferring` state that owns the session for the whole
handoff. Caller finals accumulate but no turn starts; held speech is answered only
after a failed handoff is honestly reported. Nothing is dropped.

### 5.2 Two playbacks could talk over each other — `fb5de62`

`play()` overwrote `this.playback` without settling the previous one. Reproduced
via the event trace: `tts_start(reply)` → `tts_first_byte` → `tts_start(policy)`
with no intervening settle — two synthesis loops writing to the same media socket.
They also shared the single `playbackWatchdog` timer slot and settled each other's
transcript rows.

Fixed by making `play()` preempt any unsettled playback, so "at most one active
playback" is **structural** rather than a rule every call site must remember.

Also hardened in the same commit: `end()` used `await x.close().catch(...)`, which
does not catch a *synchronous* throw. That would reject the end promise and skip
`onEnded` entirely — leaving the call with no outcome and no finalization.
Finalization is the one path that must always complete.

### 5.3 Concurrent starts created duplicate sessions for one call — `ec856db`

`VoiceGateway.startSession` checked the dedupe map but registered the session only
after two awaits (route resolution, call upsert). Reproduced: two concurrent
starts for one provider call produced **two call rows, two conversation ids and
`activeSessions === 2`**.

The second session overwrote the first in the registry, leaving the first alive
but unreachable — still holding an open STT stream, armed timers and the media
socket, and unable to ever be ended. Reachable from a duplicate provider `start`
frame or a stream token replayed inside its TTL.

Against the real Supabase store the `calls_provider_call_unique` constraint makes
both starts converge on one call id, so the duplicate *rows* would not appear in
production — but the orphaned in-process session would.

Fixed at three boundaries: a single-flight map in the gateway; atomic
check-and-insert in the in-memory store (the Supabase store already gets this from
the unique constraint + 23505 recovery — the double must uphold the same contract
or tests pass on a guarantee production does not share); and a synchronous latch
on the media socket.

## 6. Interruption and cancellation

MOCK-VERIFIED. Barge-in requires 250 ms of sustained speech, or a non-empty STT
partial, so TTS bleed does not cut the agent off. On barge-in: synthesis is
aborted, the provider playout buffer is cleared, what the caller actually heard is
computed (mark-acked, or time-based when the provider has no marks), and the turn
is recorded with that delivery status.

- **during TTS** → playback cut, delivery recorded as `interrupted` with the heard portion
- **during generation** → runtime turn aborted; if nothing committed, **nothing is
  persisted** and the partial utterance is merged into the next turn
  (`"my bill is"` + `"three thousand"` → one turn)
- **during tool execution** → see §8
- **repeated / immediately before session end** → covered by tests
- **measured barge-in latency**: p50 0 ms, p95 1 ms, max 2 ms (in-process; the
  caller's perceived latency is dominated by the provider's downstream buffer)

`interrupt()` and `end()` are idempotent.

## 7. Concurrency decisions

| Hazard | Mechanism |
| --- | --- |
| concurrent model generations | turns strictly serialized; finals held, never dropped |
| overlapping TTS | single-playback invariant enforced in `play()` (§5.2) |
| stale STT / provider events | `sttGeneration` checked in every callback |
| duplicate STT finals | `seenUtteranceIds` dedupe |
| duplicate provider `start` | single-flight + socket latch (§5.3) |
| out-of-order provider status | `pathToCallState` walks the shortest legal path |
| late events after termination | `setState` is a no-op once `ended`; Postgres terminal trigger |
| termination during generation | `end()` aborts, then awaits the in-flight turn (2 s cap) |
| handler ignoring its abort signal | `ABANDON_GRACE_MS` treats the turn as settled |
| reconnect while work is active | one STT reconnect, bounded buffer; one media reconnect window |
| duplicate business actions | commit-point model (§8) |

Nothing here relies on timing luck.

## 8. Tool/voice interaction and act-then-narrate

The runtime honours cancellation **only while the turn is uncommitted**. Once an
action has succeeded, the turn runs to completion regardless of interruption, so
its narration, transcript and conversation state stay consistent with what the
business systems now contain; the *channel* then decides whether the reply is
still delivered. A cancelled turn persists nothing.

This is the correct answer to "customer interrupts mid-tool": the tool is **not**
cancelled once it has committed, it is **not** re-run, and the reply is recorded as
`not_delivered` so the model is told the truth next turn. An interrupted call
therefore cannot create duplicate appointments, CRM updates, leads or messages.

Act-then-narrate is preserved end to end: the model proposes, the application
validates and executes, and only verified results are narrated. The transfer path
makes this explicit — the caller always hears the deterministic
`transferAnnounce` line, whatever the model said, and hears `transferFailed` if
the bridge did not succeed. The transfer **target** is tenant-configured and never
passes through the model. When no live handoff is available, the handoff tool
returns `claimsPermitted: []` and instructs the model to promise a callback rather
than a connection.

## 9. Provider abstraction

Three provider-neutral ports, all with deterministic fakes and contract tests:

- **Telephony** (`telephony-provider.ts`) — control (webhook verify/parse, answer,
  reject, hangup, transfer) plus a media-stream codec. `verifyWebhook` is **on the
  interface** so no adapter can forget it, and it **fails closed**: an adapter
  built without its secret rejects every request as `not_configured`.
- **Streaming STT** — partial/final/endpoint/error/closed, cancellable, with
  `alternativeLanguages` and phrase hints. Language-agnostic: Telugu/Tenglish needs
  no redesign, only an adapter.
- **Streaming TTS** — cancellable synthesis, first-audio event, completion.

One reference adapter exists (Twilio-Media-Streams-compatible JSON/base64 μ-law,
HMAC-SHA1 signatures). The vendor choice remains **open**; config admits only
`fake` for STT/TTS because no vendor has been evaluated or credentialed.

## 10. Security results

| Check | Status | Evidence |
| --- | --- | --- |
| Webhook signature verification | MOCK-VERIFIED | on the interface, constant-time, fails closed; tests cover unsigned/wrong/no-secret |
| Media socket authentication | MOCK-VERIFIED | short-lived HMAC token bound to callId+from+to; tests cover missing/tampered/other-number |
| Tenant isolation (app) | MOCK-VERIFIED | two-tenant gateway test; every store call is tenant-scoped |
| Tenant isolation (database) | VERIFIED | `check:rls` passes as real `authenticated`/`service_role` roles, covering `calls`, `call_events`, `call_transcript_turns`, `conversation_outcomes`, `phone_suppressions` |
| Tenant identity never from payload | VERIFIED (source) | resolved server-side from the dialled number |
| Transfer target never model-chosen | MOCK-VERIFIED | tenant-configured E.164 only; test asserts it never goes elsewhere |
| Closed tool registry | VERIFIED | `check:architecture`; the model cannot name arbitrary tools or execute code |
| Terminal-state protection | VERIFIED | Postgres trigger + TS guard + SQL/TS parity test |
| Config fails closed | VERIFIED (source) | the process refuses to start without both secrets |
| Request body bound | VERIFIED (source) | 64 KB cap |
| Transcript text in logs | VERIFIED (source) | events carry counts/codes/durations only, never transcript text |

**Known weakness (documented, not fixed):** a valid stream token replayed inside
its TTL (default 120 s) does not create a second session — the single-flight fix
makes it *reattach* — but reattaching **redirects the call's audio to the
presenting socket**. This is the same mechanism legitimate media reconnection
uses, so restricting it needs evidence about real provider reconnect behavior that
we do not have. Mitigations today: short TTL and TLS delivery. Recommended
follow-up: allow reattach only while the session is actually awaiting reconnection.
Flagged rather than changed, because guessing at provider reconnect semantics
could break real calls.

## 11. Token optimization

The phone channel previously inherited the **web-chat** context budget (32,000
chars) despite declaring `latencySensitivity: "high"`. It now has
`VOICE_CONTEXT_LIMITS`, a re-budgeting of the existing layered builder.

Measured on an identical realistic mid-call context (30 prior turns, 8 snippets):
**9,335 → 4,877 chars, a 47.8% reduction**. Knowledge is cut hardest; tool
descriptors are deliberately **not** trimmed, because that removes a capability
rather than detail. Full rationale: `docs/VOICE_TOKEN_BUDGET.md`.

Prompt caching is **NOT IMPLEMENTED** — the static layer is a natural cache prefix
and is the obvious next win.

## 12. Latency

Measured with mock providers (`npm run voice:latency`, 20 calls × 5 turns):

| Stage | p50 | p95 |
| --- | --- | --- |
| `stt_final` | 203 ms | 209 ms |
| `agent_turn` | 602 ms | 607 ms |
| `tts_first_byte` | 202 ms | 206 ms |
| **`turn_complete`** (end-of-speech → first audio) | **1,008 ms** | **1,017 ms** |
| **`tts_cancel`** (barge-in) | **0 ms** | **1 ms** |

The meaningful result: `turn_complete` (1,008 ms) is almost exactly the sum of the
injected delays (1,007 ms), so **HALO's own coordination overhead is ~1 ms per
turn**. The platform is not the bottleneck; the providers will be. Barge-in
cancellation is genuinely instantaneous in-process.

Real vendor and PSTN latency is **NOT MEASURED**. See `docs/VOICE_LATENCY_MODEL.md`.

## 13. Tests executed

| Gate | Result |
| --- | --- |
| `npm run test` | **782 passed** / 84 files (baseline 774; +8 new, 0 regressions) |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS |
| `npm run preflight:ci` | PASS (with env loaded; it does not read `.env.local` itself) |
| `npm run check:architecture` | PASS |
| `npm run check:neutral` | PASS |
| `npm run check:migrations` | PASS — 20 migrations on a fresh database |
| `npm run check:rls` | PASS — real-role tenant isolation on a fresh database |

Coverage spans the state machine (valid/invalid/terminal transitions, SQL parity),
interruption (during TTS, generation, repeated, before end), concurrency (stale,
duplicate, out-of-order, simultaneous), security (cross-tenant, signatures, token
tampering), provider failures (timeout, disconnect, malformed, duplicate) and the
full voice → runtime → voice round trip. All Phase 1–2 tests still pass unchanged.

## 14. Real-provider validation — **BLOCKED**

No credentials exist for telephony, STT or TTS. This is **BLOCKED**, not complete,
and no part of the system should be described as live-validated.

Procedure to run when credentials exist:

1. Configure `TELEPHONY_PROVIDER`, its account credentials,
   `VOICE_GATEWAY_PUBLIC_WS_URL` and `VOICE_STREAM_TOKEN_SECRET` (≥32 chars).
2. Provision a DID and point its voice webhook at
   `POST /telephony/<provider>/inbound`; point status callbacks at `.../status`.
3. Insert the number into `phone_numbers` bound to a tenant, agent and a
   **published** agent version.
4. Place a real inbound PSTN call and verify, in order: call established → audio
   received → STT final → Agent Runtime invoked → reply generated → TTS → audio
   returned → barge-in mid-reply → clean termination → `calls` row terminal with a
   disposition and a complete transcript.
5. Record p50/p95 for every stage from `call_events`, plus provider, environment,
   date and configuration.
6. Exercise failures deliberately: provider disconnect mid-synthesis, STT drop,
   hangup mid-tool. Verify no success is ever narrated for an unconfirmed action.

Until every step is recorded, real-provider validation stays **BLOCKED**.

## 15. Remaining blockers

1. **No telephony/STT/TTS credentials** — blocks live validation and real latency.
2. **No STT/TTS vendor chosen** — deferred to the Phase 4 evaluation; config
   deliberately admits only `fake`.
3. **No Telugu/Tenglish speech quality evidence** — needs a vendor and native
   reviewers (Phase 4, P4-12).
4. **No embedding decision / native eval set** for multilingual retrieval (P4-11).

## 16. Known limitations

- Everything is **MOCK-VERIFIED only**. The fakes are deterministic and faithful to
  the contracts, but they are not vendors.
- Stream-token replay can redirect call audio within the token TTL (§10).
- Delivery estimation is **time-based** when a provider does not support playback
  marks, so the "heard portion" is approximate on those providers.
- One STT reconnect and one media reconnect; beyond that the call ends politely.
- No recording, and no recording authorization model — **OUT OF SCOPE** for Phase 3.
- No outbound campaign dialer; outbound call states exist but are unused.
- The voice context limits are reasoned defaults, **not tuned** against call quality.
- Prompt caching is not implemented.
- `services/voice-gateway` has no horizontal-scaling story: sessions are in-process,
  so a restart drops live calls (graceful drain exists; session migration does not).

## 17. Delegation guidance

**Safe for a smaller/cheaper model (e.g. GLM-5.3 Flash):**
- adding a new STT/TTS adapter behind the existing ports, following the fakes and
  the contract test kit
- adding tenant-facing CRUD, dashboard views for calls/transcripts, fixture data
- prompt/copy changes to the deterministic policy lines
- mechanical test expansion over existing patterns; formatting; type fixes
- documentation updates that follow a decided design

**Still requires frontier-level reasoning:**
- anything touching `voice-session.ts` turn/playback/generation lifecycle — the
  three defects this session were all in interleavings that look correct in
  isolation
- the gateway's session registry, reconnection and finalization paths
- the stream-token reattach question in §10 (a security/robustness trade-off)
- act-then-narrate and the commit-point model when new side-effecting tools appear
- interpreting real-provider behavior once credentials exist: duplicate/out-of-order
  events, partial failures, and anything that could turn UNKNOWN into SUCCESS
- latency work that trades concurrency against correctness

## 18. Acceptance checklist

| Criterion | Status |
| --- | --- |
| Voice architecture documented | ✅ |
| Provider boundaries implemented | ✅ MOCK-VERIFIED |
| Voice session lifecycle implemented | ✅ MOCK-VERIFIED |
| Explicit state machine implemented | ✅ + SQL parity |
| Interruption semantics implemented | ✅ MOCK-VERIFIED |
| Cancellation semantics implemented | ✅ MOCK-VERIFIED |
| Concurrency hazards addressed | ✅ 3 defects found and fixed |
| Telephony / STT / TTS boundaries | ✅ IMPLEMENTED, fakes + contract tests |
| Agent Runtime integration | ✅ runtime unchanged and channel-independent |
| Act-then-narrate preserved | ✅ |
| Tenant isolation verified | ✅ `check:rls` as real roles |
| Security checks pass | ✅ one documented weakness (§10) |
| Failure semantics tested | ✅ |
| Observability implemented | ✅ correlated ids, per-stage latency, no transcript text in logs |
| Token/context strategy implemented | ✅ measured 47.8% reduction |
| Phase 1–2 tests still passing | ✅ 774 → 782, zero regressions |
| Build / typecheck / lint | ✅ |
| Migrations valid on a fresh database | ✅ |
| Real provider tested | ⛔ **BLOCKED** — documented, not claimed |
| Real latency measured | ⛔ **BLOCKED** — mock-only figures labelled as such |
| Documentation updated | ✅ |
| Known limitations documented | ✅ §16 |
