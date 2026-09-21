# HALO Phase 4 — Report

**Date:** 2026-09-21 · **Branch:** `main` · **Baseline:** `58697e8` (end of Phase 3)

Status vocabulary, unchanged from Phase 3: **IMPLEMENTED** (code exists) ·
**MOCK-VERIFIED** (tested against deterministic fakes) · **VERIFIED** (tested
against the real thing) · **NOT VERIFIED** · **BLOCKED** · **OUT OF SCOPE**.

The phrase "production ready" does not appear in this report, because the
evidence for it does not exist. **No call has been placed** — not through
Pipecat, not through the in-process engine, not in Telugu, not in any
language. Every latency number in this repository is from mock providers.

---

## 1. Status

| Part of the brief | Status |
| --- | --- |
| 1 Audit | COMPLETE — source, not documentation (`docs/PIPECAT_INTEGRATION.md` §1) |
| 2 Pipecat boundary | IMPLEMENTED, MOCK-VERIFIED |
| 3 Session contract | IMPLEMENTED, MOCK-VERIFIED, schema-validated both ways |
| 4 Arunodhaya agent | IMPLEMENTED as configuration outside `packages/` |
| 5 Telugu / Tenglish | IMPLEMENTED and MOCK-VERIFIED; **speech quality BLOCKED** |
| 6 Sales qualification | IMPLEMENTED, MOCK-VERIFIED; 3 defects found and fixed |
| 7 Objection handling | IMPLEMENTED, MOCK-VERIFIED |
| 8 Negotiation policy | IMPLEMENTED; **every commercial value unset — none supplied** |
| 9 Tools | IMPLEMENTED on the existing closed registry |
| 10 Human handoff | IMPLEMENTED (unchanged from Phase 3) |
| 11 Knowledge | STRUCTURED; **no verified business fact exists** |
| 12 Controlled learning | DESIGNED (`docs/ARUNODHAYA_LEARNING_LOOP.md`); never run |
| 13 Evaluation | IMPLEMENTED — 50 golden conversations, 50/50 |
| 14 Token optimization | MEASURED; the next win identified and **not** implemented |
| 15 Real Pipecat test | **BLOCKED** — no credentials for telephony, STT or TTS |
| 16 Security | MOCK-VERIFIED as tests, not as claims |

---

## 2. What Phase 3 code was retained

Everything. No Phase 3 file was rewritten, no Phase 3 test was deleted or
weakened, and the 782 Phase 3 tests pass unchanged.

The audit found that `VoiceGateway` had **exactly one media-aware line** —
`new VoiceSession({ … })`. Routing, tenant identity, the call row, the state
machine, transcript and event persistence, outcomes, usage, capacity, the
media-reconnect window and the transfer boundary are all engine-independent
and are now shared by both engines rather than reimplemented for one.

Retained and used by both paths: `gateway.ts`, `call-state.ts`,
`call-store.ts` and both stores, `session-config.ts`, `turn-handler.ts`,
`sentence-chunker.ts`, `phone-channel-adapter.ts`, the Agent Runtime, the tool
registry, the response validator, and all 20 migrations (none changed).

## 3. What Pipecat replaced

On the Pipecat path only: the in-process media loop — `voice-session.ts`,
`endpointer.ts`, `audio.ts`, the `StreamingSttProvider` / `StreamingTtsProvider`
ports and their fakes, and the telephony media codec.

**Unused, not deleted.** They still serve the `/media` path and are still the
only engine with tests that have exercised a full media loop. Deleting them
would trade a tested engine for one that has never placed a call.

## 4. The integration boundary

```text
telephony → Pipecat (transport · VAD · STT · TTS · interruption)
          → WSS /pipecat/control  (JSON text only, never audio)
          → HALO gateway (tenant · call row · state machine · transcript ·
                          outcome · transfer authority)
          → RemoteVoiceSession (turn serialization · delivery truth ·
                                silence + failure policy · handoff window)
          → PhoneTurnHandler → Agent Runtime (unchanged)
```

Full contract in `docs/PIPECAT_INTEGRATION.md`. The two decisions that define
it:

- **Interruption is Pipecat's.** It cuts playback locally and reports
  afterwards, because a round trip in the barge-in path is audible to a human.
  What HALO keeps is the part that has to be right rather than fast: which
  sentences the caller actually heard, acknowledged chunk by chunk, written to
  the transcript as `complete` / `interrupted` / `not_delivered`.
- **Every spoken word is HALO's.** Greeting, reprompt, goodbye, turn failure,
  transfer announcement and model replies all arrive as `speak` commands.
  Pipecat holds no tenant content and cannot invent, translate or reorder one.

There is deliberately **no `transfer` command on the wire**: HALO performs the
bridge to a tenant-configured number that never passes through the model.

---

## 5. Files changed

55 files, +7,734 / −48, in five commits.

| Area | Added | Changed |
| --- | --- | --- |
| Pipecat boundary | `media-session.ts`, `pipecat/{protocol,remote-session,bridge}.ts`, `voice-gateway/pipecat-control.ts` | `gateway.ts` (+1 injectable factory), `server.ts`, `config.ts`, `index.ts` |
| Negotiation | `packages/negotiation/{policy,authorization,objections,system-action,tool}.ts` | `runtime/{contracts,response-validator,tools/registry,agent-runtime}.ts`, `core/domain/agents.ts` |
| Language / qualification | — | `language/lexicon.ts`, `qualification/{engine,system-action}.ts` |
| Tenant configuration | `src/content/tenants/arunodhaya/*` (8 files) | — |
| Wiring | `src/core/services/voice/{sales-call,arunodhaya-call}.ts` | `voice/phone-channel-adapter.ts` |
| Reference worker | `services/pipecat-worker/{halo_client.py,test_halo_client.py,README.md}` | — |
| Tooling | `scripts/{arunodhaya-eval,phase4-context-budget}.ts` | `scripts/check-architecture.mjs`, `package.json` |
| Tests | 11 new files incl. the 50-conversation golden corpus | — |

---

## 6. Defects found and fixed

Each was reproduced before it was fixed.

### 6.1 Re-entrancy in the remote session — found while testing

`speakPolicyThenEnd` and `end` read `this.playback` twice across a `send()`
that a synchronous worker can settle in between, so the second read could be
`null` and the whole end path would reject — leaving the call with no
outcome. Fixed by capturing the playback first. This is the same class as the
three Phase 3 defects: correct in isolation, wrong in an interleaving.

### 6.2 Field scrambling in the qualification engine — found by the golden corpus

A caller who answered the **next** question while a read-back was pending had
it stored against the field being confirmed, and every answer after that
landed one field out. A real call produced a lead with name `"naade"` and
location `"4000 rupees"`. Nothing errored.

A correction must now be *signalled*: an explicit "no", or a bare number for a
field where a number can only be a correction. Otherwise the utterance is
released to the next question and the captured value is kept, unconfirmed.
Pinned by `tests/unit/qualification/confirmation-safety.test.ts`.

### 6.3 Free text was read back on every answer

Its parser scores below the confirmation threshold, so every location produced
"you said Kukatpally, is that right?" — the mechanical interrogation this
design is meant to avoid, and the trigger for 6.2. Confidence-gated read-back
now applies only to structured values, where being wrong is harmful and being
right is checkable. An explicit `confirm: true` is still honoured.

### 6.4 Answered-but-unconfirmed counted as unresolved

Which drove good calls towards a human. "Unresolved" now means never obtained.

### 6.5 The act-then-narrate guard did not exist in Telugu

The claim detector was English regex. Over a Telugu reply it matched nothing —
it did not fail, it silently stopped guarding, which is how an agent could
claim a booking that never happened. Claim phrases and the safe fallback line
are now tenant-authored per language, and `claimGuardCoverage()` reports which
claim kinds an agent has no guard for instead of assuming it is fine.

### 6.6 Smaller

- A human request was buried under a pending read-back; it is now surfaced
  above it.
- The do-not-call lexicon missed transliteration variants ("cheyyakandi" vs
  "cheyakandi"). A DNC missed on a doubled consonant is a compliance failure.

---

## 7. Tests

| Gate | Result |
| --- | --- |
| `npm run test` | **932 passed** / 94 files (baseline 782; +150, 0 regressions) |
| `python3 -m unittest` (worker) | 10 passed |
| `npm run eval:arunodhaya` | **50 / 50** golden conversations |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS |
| `npm run preflight:ci` | PASS |
| `npm run check:architecture` | PASS |
| `npm run check:neutral` | PASS |
| `npm run check:migrations` | PASS — 20 migrations on a fresh pgvector PG16 |
| `npm run check:rls` | PASS — real `authenticated` / `service_role` roles |
| `npm run demo:arunodhaya seed` / `reset` | VERIFIED against a fresh pgvector PG16 (§7.1) |

### 7.1 The demo tenant, exercised against a real database

`npm run demo:arunodhaya seed` was run against a fresh pgvector PG16 with all
20 migrations applied: seed → re-seed (no change, as designed) → reset →
re-seed → the route resolves with an active agent, an active DID and a
published live version. The remote-database guard and the unconfirmed-reset
guard both refuse.

One finding: **a tenant cannot be deleted, and that is correct.** Published
`agent_versions` rows are immutable by trigger (0013), so Postgres refuses the
cascade. Erasing them would erase the answer to "what was this agent
authorized to offer during that call?". `reset` therefore archives the agent,
clears its live version and disables the DID — traffic stops immediately,
`seed` brings it back, and the history survives.

New coverage: the Pipecat protocol (10), the remote engine's state machine and
delivery truth (16), the control plane end to end over a real WebSocket (8),
negotiation policy and authorization (14), objections and ground truth (11),
the multilingual claim guard (7), read-back safety (8), the Arunodhaya
configuration (16), Phase 4 security (9), and the 50-conversation corpus.

---

## 8. Real-call results — **NONE**

No call has been placed through the Pipecat path. `services/pipecat-worker`
is a **reference implementation labelled NOT VERIFIED**: its protocol logic is
tested, its media behaviour is not, and it has never seen a telephony
provider, an STT vendor, a TTS vendor or a Pipecat pipeline.

What is proven is the wire format, from both sides: HALO's side end to end
over a real local WebSocket, the worker's side by protocol tests against a
fake connection. That is a real guarantee and it is not a phone call.

### Procedure to run when credentials exist

1. Choose and credential an STT and a TTS vendor; add each as an enum value
   and an adapter. Configuration deliberately admits only `fake` today.
2. Deploy the worker. Set `VOICE_MEDIA_ENGINE=pipecat`,
   `VOICE_PIPECAT_MEDIA_WS_URL`, `VOICE_GATEWAY_PUBLIC_WS_URL` and
   `VOICE_STREAM_TOKEN_SECRET` (≥32 chars).
3. Provision a DID, point its voice webhook at
   `POST /telephony/<provider>/inbound` and its status callbacks at
   `.../status`. Insert the number into `phone_numbers`, bound to the tenant,
   the agent and a **published** version.
4. Place a real inbound PSTN call in Telugu and verify, in order: call
   established → `hello` accepted → `ready` delivered → greeting heard → STT
   final → Agent Runtime invoked → reply spoken → **barge-in mid-reply** →
   transcript shows the heard portion only → clean termination → `calls` row
   terminal with a disposition and a complete transcript.
5. Record from `call_events`, p50 and p95, per stage: `stt_final`,
   `agent_turn`, `tts_first_byte`, `turn_complete` (end-of-speech → first
   audio), `tts_cancel` (interruption). Record provider, vendors, region,
   date and configuration alongside them.
6. Exercise failures deliberately: worker restart mid-call, STT drop, TTS
   drop, hangup mid-tool, a lost `playback stopped` report. Verify no success
   is ever narrated for an unconfirmed action.
7. Repeat for Tenglish, code switching, an objection, a negotiation push, a
   qualification run, a booking attempt and a handoff.

Until every step is recorded, the Pipecat integration stays **BLOCKED**, and
no part of it should be described as validated.

## 9. Telugu results

| What | Status |
| --- | --- |
| Deterministic Telugu understanding (intents, numerals, money/units, phone, pincode, names, time, script + transliteration + code switching) | MOCK-VERIFIED against test corpora |
| Telugu qualification, objections, escalation and claim guarding end to end | MOCK-VERIFIED — 50/50 golden conversations |
| Telugu **speech recognition** quality (WER on 8 kHz phone audio) | **BLOCKED** — no vendor, no credentials |
| Telugu **speech synthesis** quality (MOS, native panel) | **BLOCKED** |
| Whether a real model's Telugu *sounds* natural | **NOT MEASURED** — the corpus scripts the model |
| Multilingual retrieval (embedding choice, native eval set) | **BLOCKED** — carried from Phase 3 §15.4 |

The `endOfSpeechMs: 900` setting (vs the 700 ms default) is a hypothesis about
Telugu pause structure tuned on mock audio. It must be re-tuned on real calls.

## 10. Latency

**Unchanged from Phase 3, and still mock-only.** The in-process engine
measures p50 1,008 ms end-of-speech → first audio against 1,007 ms of injected
delay, i.e. ~1 ms of HALO coordination overhead, and 0–1 ms barge-in
cancellation (`docs/VOICE_LATENCY_MODEL.md`).

**The Pipecat path has no latency measurement at all** — not even a mock one,
because there is no worker to measure. What the design predicts, and what must
be checked against real numbers, is:

- barge-in gets *faster*, because the cut is local to the worker rather than
  travelling to HALO and back;
- each turn gains one control-plane round trip between the final transcript
  and the `speak` command — small and server-to-server, but not zero;
- time-to-first-audio becomes dominated by the vendors, as Phase 3 predicted.

None of that is measured. Treat it as a hypothesis.

## 11. Token usage

Measured with `npm run phase4:context` on an identical realistic mid-call
context (30 prior turns). Characters on the rendered prompt, not estimates:

| Configuration | Rendered | Budgeted | Limit |
| --- | --- | --- | --- |
| web-chat budget, no Phase 4 sections | 8,816 | 4,571 | 32,000 |
| voice budget, no Phase 4 sections (Phase 3) | 8,908 | 4,277 | 9,000 |
| voice budget, with Phase 4 sections | 11,612 | 6,975 | 9,000 |

Phase 4 **adds** 2,704 characters per turn: qualification ground truth, the
commercial policy, and the list of questions the agent has no verified answer
for. That is a deliberate trade — it is what replaces the model guessing — but
it is an increase and is reported as one.

Where the Phase 4 voice prompt goes: agent prompt template 3,210; platform
rules 1,826; tool descriptors including JSON schema 801; system actions 2,698;
recent history 490.

**The next real win, measured:** 5,036 characters (43%) is a stable prefix,
identical on every turn of every call for this agent version. That is a
prompt-caching candidate and **prompt caching is still NOT IMPLEMENTED**.

**An honest gap:** `maxTotalChars` bounds the builder's *inputs*, not the
rendered string. The composer's own headings, the rules section and tool JSON
schemas add 4,637 characters that the budget does not see. Measured here for
the first time; not fixed.

## 12. Security results

Nine Phase 4 properties are tests rather than assertions
(`tests/integration/phase4-security.test.ts`,
`tests/integration/pipecat-gateway.test.ts`):

| Check | Status |
| --- | --- |
| A worker cannot choose a tenant (token bound to call id + both numbers) | MOCK-VERIFIED |
| A worker cannot answer for another tenant's number (tampered `to` → 1008) | MOCK-VERIFIED |
| A worker cannot claim another call (no call row created) | MOCK-VERIFIED |
| Identity never travels upward (no inbound frame has an identity field) | MOCK-VERIFIED |
| Incompatible protocol major version refused | MOCK-VERIFIED |
| Malformed, binary and oversized frames cannot act | MOCK-VERIFIED |
| `ready` carries no token, secret or key | MOCK-VERIFIED |
| No arbitrary URL execution (worker URL is validated env config) | MOCK-VERIFIED |
| No arbitrary provider access (enums admit only vetted adapters) | MOCK-VERIFIED |
| Pipecat engine fails closed without a worker URL or a bridge | MOCK-VERIFIED |
| Tool registry offers only bound tools; unknown names throw | VERIFIED |
| Concessions re-checked at execution time, not only in the prompt | MOCK-VERIFIED |
| Transfer target never model-chosen (no transfer command exists) | VERIFIED (source) |
| Model never controls tenant identity | VERIFIED (source) |
| Webhook signatures fail closed | MOCK-VERIFIED (Phase 3) |
| Tenant isolation in the database | VERIFIED — `check:rls` as real roles |

**Known weakness, carried forward unchanged from Phase 3 §10:** a valid stream
token replayed inside its TTL re-attaches the session and redirects the call's
audio to the presenting socket. The Pipecat path inherits it because it
inherits the token mechanism. Still deferred for the same reason — the fix
needs evidence about real reconnect behaviour that does not exist.

---

## 13. Remaining blockers

1. **No telephony, STT or TTS credentials.** Blocks every real-call claim.
2. **No STT/TTS vendor chosen or scored on Telugu.** Blocks Telugu quality.
3. **No verified business facts from Arunodhaya.** The agent currently cannot
   quote a price, offer a discount or answer a commercial question — by
   design, and correctly, until they are supplied.
4. **No commercial policy values.** Every discount is unset.
5. **No native-speaker review panel.** Blocks any claim about Telugu quality.
6. **No embedding decision or native eval set** for multilingual retrieval.
7. **The reference worker is unverified.**

## 14. Known limitations

- Everything is MOCK-VERIFIED. The fakes are faithful to the contracts; they
  are not vendors, and the simulated worker is not Pipecat.
- `RemoteVoiceSession` re-expresses the conversation policy `VoiceSession`
  expresses over audio. The alternative — surgery on the 1,121-line file the
  Phase 3 report names as highest-risk — was judged worse, but this is real
  duplication and both engines must be changed together.
- The golden corpus scripts the model, so it cannot score naturalness or
  factual accuracy of prose. It scores what is deterministic, including
  several models that deliberately misbehave.
- No booking tool is bound on the phone path yet; a claimed booking is caught
  by the validator rather than being possible.
- Prompt caching is not implemented; `maxTotalChars` does not bound the
  rendered prompt.
- Scaling is unchanged: sessions are in-process and a restart drops live
  calls. Pipecat adds a second process to that story, not a solution.
- Recording, recording authorization, DLT and the national DNC registry are
  **OUT OF SCOPE** and unimplemented. Internal DNC suppression works.
- The `endOfSpeechMs` and voice context limits are reasoned defaults, not
  tuned against call quality.

## 15. Acceptance checklist

| Criterion | Status |
| --- | --- |
| Phase 3 audited against source | ✅ |
| Pipecat boundary designed and documented | ✅ |
| Session contract defined and schema-validated both ways | ✅ |
| Tenant/agent identity resolvable only server-side | ✅ MOCK-VERIFIED |
| Phase 3 not rebuilt; 782 Phase 3 tests unchanged | ✅ |
| Arunodhaya configured with no core contamination | ✅ `check:neutral` |
| Telugu / Tenglish deterministic layer | ✅ MOCK-VERIFIED |
| Qualification configurable and natural | ✅ 3 defects fixed |
| Objection handling implemented, not aggressive | ✅ |
| Negotiation separated from authorization | ✅ |
| No invented prices, discounts or business facts | ✅ asserted by test |
| Tools schema-validated, authorized, tenant-scoped, auditable | ✅ |
| Act-then-narrate preserved, and guarded in Telugu | ✅ |
| Human handoff never falsely claimed | ✅ |
| Knowledge structured; pending facts explicit | ✅ |
| Controlled learning loop designed | ✅ never run |
| Golden corpus | ✅ 50/50 |
| Context size measured, before/after | ✅ increase reported honestly |
| Security checks | ✅ as tests |
| Build / typecheck / lint / migrations / RLS | ✅ |
| **Real Pipecat call** | ⛔ **BLOCKED** |
| **Real latency** | ⛔ **BLOCKED** |
| **Telugu speech quality** | ⛔ **BLOCKED** |

## 16. Delegation guidance

**Safe for a smaller model:** adding STT/TTS adapters behind the existing
ports; adding objection cues, phrase hints and lexicon variants; adding golden
conversations over existing patterns; tenant-facing CRUD and dashboard views;
documentation that follows a decided design.

**Still requires frontier-level reasoning:** anything in
`voice-session.ts` or `pipecat/remote-session.ts` touching the
turn/playback/generation lifecycle — every defect in Phase 3 and Phase 4 lived
in an interleaving that looks correct in isolation; the qualification
engine's confirmation branch (§6.2 is subtle and silent); the commercial
policy and anything that decides what may be promised; interpreting real
provider and worker behaviour once credentials exist; and the stream-token
re-attach trade-off.
