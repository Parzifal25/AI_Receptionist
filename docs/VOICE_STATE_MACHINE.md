# HALO Voice — State Machines (Phase 3)

Two **separate** state machines, deliberately not merged:

| Machine | Owns | Lives in | Persisted |
| --- | --- | --- | --- |
| **Call state** (`CallState`) | what the telephony leg is doing | `packages/voice/call-state.ts` | `calls.state` (+ Postgres trigger) |
| **Session state** (`VoiceSessionState`) | what the media loop is doing this second | `packages/voice/voice-session.ts` | not persisted (in-process) |

They are separate because they change at different rates and have different
authorities. A provider webhook moves the call leg; the caller's voice moves the
session. Collapsing them would let a late webhook reach into the media loop.

A third concept, **business outcome** (`CallDisposition`), is not a state machine
at all: it is computed deterministically at finalization. A `completed` call can
be `not_interested`; a `no_answer` call has no outcome.

---

## 1. Call state (`CallState`)

```text
created ─▶ queued ─▶ dialing ─▶ ringing ─▶ connected ─▶ in_conversation ─▶ completing ─▶ completed
   │         │         │          │           │              │  ▲               ▲
   │         │         │          │           │              ▼  │               │
   │         │         │          │           │          interrupted ───────────┤
   │         │         │          │           └──────────────┴─▶ transferred    │
   │         │         │          ├─▶ no_answer / busy                          │
   │         │         ├─▶ failed (any non-terminal state may fail)             │
   │         └─▶ cancelled                                                      │
   └────────────────────────────────────────────────────────────────────────────┘
```

Inbound calls start at `ringing`; `created`/`queued`/`dialing` are outbound-only.

### Transition table

| From | Allowed to |
| --- | --- |
| `created` | `queued`, `dialing`, `cancelled`, `failed` |
| `queued` | `dialing`, `cancelled`, `failed` |
| `dialing` | `ringing`, `connected`, `no_answer`, `busy`, `failed`, `cancelled` |
| `ringing` | `connected`, `no_answer`, `busy`, `failed`, `cancelled` |
| `connected` | `in_conversation`, `completing`, `transferred`, `failed` |
| `in_conversation` | `interrupted`, `completing`, `transferred`, `failed` |
| `interrupted` | `in_conversation`, `completing`, `failed` |
| `completing` | `completed`, `failed` |
| `completed`, `transferred`, `no_answer`, `busy`, `failed`, `cancelled` | **nothing (terminal)** |

- `interrupted` is the **media-dropped** state, not barge-in. It may recover to
  `in_conversation` on one media reconnect, or proceed to `completing`.
- Terminal states accept nothing. This is enforced **twice**: in TypeScript by
  `assertCallTransition`, and in Postgres by the 0020 trigger — so a late or
  replayed provider webhook cannot resurrect a finished call *even through the
  service role*. `tests/unit/voice/call-state-sql-parity.test.ts` pins the two
  tables against each other so they cannot drift.
- A provider status that skips intermediate states (an inbound `completed`
  while we are `in_conversation`) is applied through `pathToCallState`, the
  shortest legal path, so every stored transition is individually legal.

**Invalid transitions** raise `AppError.conflict` with
`reason: "invalid_call_transition"`. They are never silently coerced: an
unexpected provider status is an error to record, not a state to adopt.

---

## 2. Session state (`VoiceSessionState`)

```text
idle ─start─▶ speaking(greeting) ─▶ listening ⇄ user_speaking ─endpoint+final─▶ thinking
                   ▲                    │                                        │
                   │                    └─silence─▶ speaking(reprompt)           ▼
                   └──────────────────────────────────────────────────── speaking(reply)

  barge-in:  speaking ─sustained caller speech─▶ user_speaking   (TTS aborted, buffer cleared)
             thinking ─sustained caller speech─▶ user_speaking   (turn aborted, utterance merged)
  transfer:  speaking(reply) ─▶ transferring ─announce + bridge─▶ ended | listening (on failure)
  any ─end()─▶ ending ─▶ ended
```

### States

| State | Meaning | Leaves on |
| --- | --- | --- |
| `idle` | constructed, not started | `start()` |
| `listening` | no caller speech detected, awaiting input | speech start, silence timeout, final commit |
| `user_speaking` | endpointer reports speech in progress | end-of-speech (local VAD or STT `endpoint`) |
| `thinking` | a runtime turn is in flight | turn settles, barge-in, turn timeout |
| `speaking` | synthesized audio is being delivered | playback completes, barge-in, preemption |
| `transferring` | a human handoff owns the session | bridge succeeds (`ended`) or fails (`listening`) |
| `ending` | teardown started, final policy line may still play | teardown completes |
| `ended` | terminal; accepts nothing, `setState` is a no-op | — |

### Why `transferring` exists

It was added in Phase 3 hardening after a reproduced defect. Previously the
session awaited the provider bridge while sitting in `listening`, so caller
speech during the handoff committed an utterance and started a **new runtime
turn**. That turn could execute a business action for a caller already being
bridged to a human, and a successful transfer's `end("transferred")` would cut
it off mid-flight.

While `transferring`:

- caller finals **accumulate** (`onFinal` and `commitUtterance` hold, never drop);
- **no turn starts**;
- `play()` does not downgrade the state to `speaking`, so the announcement's own
  completion cannot hand the session back to the listen loop;
- `afterPlayback` returns early, so the nested policy prompts cannot drive the
  session — only the outer handoff sequence may.

On failure the session returns to `listening`, speaks the honest failure line,
and *then* answers the speech held during the attempt.

### Terminal and idempotency rules

- `end()` is idempotent and always resolves with the **same** summary. It is the
  only path to `ended`, and it must always reach `onEnded`: a provider `close()`
  that rejects — or throws synchronously — is caught, because a stranded call
  would have no outcome.
- `interrupt()` is idempotent and returns `false` when there is nothing to interrupt.
- `setState` is a no-op once `ended`, so a late async continuation cannot revive a
  finished session.

### Timeouts and bounds (all from `VoiceSessionConfig`)

| Bound | Default | Behavior on expiry |
| --- | --- | --- |
| `silence.timeoutMs` | 8,000 ms | reprompt; after `maxReprompts` (2) → goodbye + hang up |
| `turnTimeoutMs` | 15,000 ms | abort the turn → `turnFailure` line; `maxConsecutiveTurnFailures` (2) → goodbye |
| `finalWaitMs` | 1,500 ms | endpoint with no transcript → treat as noise, resume listening |
| `finalCommitGraceMs` | 400 ms | commit a final the local VAD did not endpoint |
| `maxCallDurationMs` | 15 min | goodbye + hang up (`max_duration`) |
| `markGraceMs` | 1,500 ms | playback watchdog beyond the audio's own duration |
| `maxSttReconnects` | 1 | then goodbye + hang up (`stt_failure`) |
| `maxUtteranceChars` | 1,000 | truncate |
| `maxTranscriptTurns` | 400 | stop appending, count the overflow |
| `maxReconnectBufferBytes` | 16,000 | bounded queue, drop-oldest |
| `ABANDON_GRACE_MS` | 1,000 ms | a handler ignoring its abort signal is treated as settled |

### Concurrency invariants

1. **Turns are strictly serialized.** A new turn never starts while one is in
   flight; finals are held and committed when it settles.
2. **At most one playback is active.** `play()` preempts any unsettled playback.
   Two synthesis loops would otherwise share the media socket, fight over the
   single playback watchdog slot and settle each other's transcript rows.
3. **Every async continuation checks a generation.** `sttGeneration`,
   `turnGeneration` and `playGeneration` mean a cancelled TTS stream, an aborted
   turn or a late STT event can never drive a newer phase.
4. **Utterance ids are deduplicated**, so a duplicate STT final is dropped.
5. **Handoffs own the session** (see `transferring` above).
6. **Nothing is dropped on cancellation**: an uncommitted turn's utterance is
   merged into the next one, so `"my bill is" + "three thousand"` becomes one turn.

### Act-then-narrate at the state level

A cancelled turn that committed **nothing** persists nothing. A turn that already
committed an action runs to completion even if the caller interrupted, and its
reply is recorded as `not_delivered` — business state and transcript never
disagree. The delivery status of every agent utterance (`complete`,
`interrupted` with the heard portion, or `not_delivered`) is fed back into the
next turn's context, so the model is told the truth about what the caller
actually heard.
