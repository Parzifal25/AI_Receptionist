# HALO ⇄ Pipecat integration

**Date:** 2026-09-21 · **Phase:** 4 · **Status:** MOCK-VERIFIED on the HALO side,
UNVERIFIED on the worker side, BLOCKED for real calls.

Status vocabulary follows `docs/PHASE3_REPORT.md`: **IMPLEMENTED** (code exists) ·
**MOCK-VERIFIED** (tested against deterministic fakes) · **VERIFIED** (tested against
the real thing) · **NOT VERIFIED** · **BLOCKED**.

---

## 1. Audit — what Phase 3 already was

Phase 3 was read against source, not against its own documentation. What it
found matters, because it determined the size of this integration.

`VoiceGateway` (`packages/voice/gateway.ts`, 646 lines) owns:

| Responsibility | Media-aware? |
| --- | --- |
| Resolving the dialled number to tenant, agent and published version | no |
| Creating the call row and the phone conversation, idempotently | no |
| Walking the technical call state machine, one legal transition at a time | no |
| Buffering and persisting call events and transcript turns | no |
| Computing and recording the business outcome, and DNC suppression | no |
| Usage and per-stage latency capture | no |
| Session capacity and the media-reconnect window | no |
| Performing the provider transfer to a tenant-configured number | no |
| `new VoiceSession({ stt, tts, output, inputFormat, … })` | **yes** |

**Exactly one line of the gateway was media-aware.** Everything else is
engine-independent and had no business being rewritten, duplicated or
reimplemented in Python.

Below it, `VoiceSession` (1,121 lines) mixes two things that Phase 3 had no
reason to separate:

- a **media loop** — STT stream, TTS synthesis, μ-law conversion, energy VAD,
  endpointing, playback marks, barge-in detection;
- a **conversation policy** — turn serialization, the superseded-utterance
  merge, silence reprompts, the turn-failure line, the handoff window, the
  single-playback invariant, delivery truth, the summary.

Pipecat replaces the first. It must not be given the second.

### What is retained, unchanged

`packages/voice/gateway.ts` (bar the one seam), `call-state.ts`,
`call-store.ts` and both stores, `session-config.ts`, `turn-handler.ts`,
`sentence-chunker.ts`, `phone-channel-adapter.ts`, the whole Agent Runtime,
the tool registry, the response validator, and the migrations. The in-process
`VoiceSession` is retained too — it still runs the `/media` path and is still
the engine the existing 782 Phase 3 tests exercise.

### What becomes unused on the Pipecat path

`voice-session.ts`, `endpointer.ts`, `audio.ts`, the `StreamingSttProvider`
and `StreamingTtsProvider` ports and their fakes, and the telephony media
codec. **Unused, not deleted.** Deleting them would remove the only engine
that is actually tested, in exchange for one that has never placed a call.

### What must not be duplicated

The call lifecycle. A Pipecat bridge that re-resolved tenants, re-created call
rows and re-computed outcomes would be a second implementation of the part
where being wrong is expensive — and the two would drift. It is shared by
construction: both engines sit behind the same gateway.

---

## 2. The boundary

```text
telephony provider
      │  webhook (signature-verified, fails closed)
      ▼
HALO voice gateway  ──▶ resolve dialled number → tenant/agent/version
      │                 mint stream token (HMAC over callId + from + to)
      │  answer: "stream to <pipecat>", parameters carry the token
      ▼
Pipecat worker  ── transport · VAD · STT · TTS · interruption · frames
      │  WSS /pipecat/control   JSON text only, never audio
      ▼
HALO voice gateway  ── call row · state machine · transcript · events ·
      │                outcome · usage · capacity · transfer authority
      ▼
RemoteVoiceSession  ── turn serialization · delivery truth · silence policy ·
      │                failure policy · handoff window · spoken lines
      ▼
PhoneTurnHandler ──▶ HALO Agent Runtime (unchanged, channel-independent)
      ▼
tools · knowledge · conversation state · qualification · negotiation policy
```

| Pipecat owns | HALO owns |
| --- | --- |
| audio transport | tenant, agent, agent version |
| media pipeline and frame processing | conversation and its state |
| STT streaming and endpointing | business state and qualification |
| TTS streaming and playout | tools, knowledge, workflows, CRM, scheduling |
| **cutting playback on caller speech** | authorization, commercial policy, memory |
| provider-specific media behaviour | escalation decisions and transfer authority |
| reporting what was heard and what played | every word the caller hears |

### Why interruption is Pipecat's

This is the one place where the line could reasonably have gone the other
way, so it is stated explicitly: **Pipecat cuts playback locally and reports
it afterwards.** Asking HALO for permission would put a network round trip in
the only path where milliseconds are audible to a human being.

What HALO keeps is the part that has to be *right* rather than fast: which
sentences the caller actually heard. Pipecat acknowledges each chunk as it
leaves the earpiece; HALO settles the playback from those acknowledgements
and writes the transcript as `complete`, `interrupted` (with the heard
portion) or `not_delivered`. The model is told the truth on the next turn.

### Why the deterministic lines are not Pipecat's

The greeting with its AI disclosure, the silence reprompt, the goodbye, the
turn-failure line and the transfer announcement are tenant-authored content in
the agent's own language. They arrive as `speak` commands at the moment they
are due. Pipecat therefore holds no tenant content and cannot invent,
translate or reorder one — the same reason a phone agent missing any of those
lines is not answered at all (`packages/voice/session-config.ts`).

---

## 3. The session contract

`packages/voice/pipecat/protocol.ts`. One socket per call, text frames only,
every inbound frame schema-validated before any session code sees it.

### Identity

Every session carries, for its whole life:

| Field | Source |
| --- | --- |
| `tenantId` | the dialled number, resolved server-side (`resolveInboundRoute`) |
| `agentId`, `agentVersionId`, `agentVersion` | the agent's published version at routing time, pinned for the call |
| `callId`, `sessionId` | the call row (one call, one session) |
| `conversationId` | the phone conversation the transcript and state hang off |
| `correlationId` | per-call correlation across events, logs and analytics |
| `turnId` | per runtime turn; travels on `speak` and back on delivery |

Identity travels **HALO → Pipecat, in `ready`, and never the other way.** No
inbound frame has a field for a tenant, an agent or a conversation; a worker
that adds one has it dropped by the schema, which is asserted by test.

### Initialization

1. Provider posts the inbound webhook. HALO verifies the signature (fails
   closed), resolves the dialled number, and refuses the call outright if the
   agent is not configured for voice.
2. HALO mints a stream token — HMAC-SHA256 over `providerCallId | from | to |
   expiry`, default TTL 120 s — and answers with "stream to the worker",
   passing the token and `haloControlUrl` as stream parameters.
3. The worker connects `WSS /pipecat/control` and sends `hello` with the
   token and the numbers it was handed.
4. HALO verifies the token against those exact claims, starts (or re-attaches)
   the session through the unchanged gateway, and replies `ready` with the
   identity above plus media parameters.
5. HALO immediately sends the greeting as a `speak`.

### Frames

**Pipecat → HALO**

| Frame | Meaning |
| --- | --- |
| `hello` | authenticate and open (protocol major version checked) |
| `speech_started` / `speech_stopped` | remote VAD; `speech_started` during generation is a barge-in |
| `transcript` | `final` or interim; `language` and `confidence` are `null` unless the vendor reported them |
| `playback` | `first_audio`, `chunk_played(i)`, `stopped(completed\|interrupted\|failed)` |
| `dtmf` | one digit |
| `usage` | cumulative inbound/outbound audio ms and TTS characters |
| `error` | `stt` / `tts` / `transport` / `pipeline`, with an honest `retryable` |
| `bye` | the media leg is gone |

**HALO → Pipecat**

| Command | Meaning |
| --- | --- |
| `ready` | identity + media config (no tenant content, no secrets) |
| `speak` | pre-chunked text, `kind`, `turnId`, `interruptible` |
| `stop_playback` | stop that playback |
| `hangup` | end the leg |

There is deliberately **no `transfer` command**. The bridge is performed by
HALO through the telephony provider, to a tenant-configured E.164 number that
never passes through the model. The caller always hears the tenant's
`transferAnnounce` line before it, and `transferFailed` if the provider did
not accept it.

### Per-frame semantics that matter

- **Final transcript.** `utteranceId` must be stable, so a re-sent final is
  de-duplicated rather than answered twice. HALO holds finals until the
  utterance endpoints, then commits exactly one turn.
- **Interruption.** The worker cuts first and reports second. HALO settles the
  playback from the chunks already acknowledged — it never upgrades an unknown
  delivery to `complete`, including when a `stopped` report is lost (a
  watchdog settles it as interrupted and emits `playback_report_lost`).
- **Agent response.** `speak` preempts any unsettled playback, so "at most one
  active playback" is structural rather than a rule each call site remembers.
- **Tool execution.** Unchanged: the runtime honours cancellation only while a
  turn is uncommitted. Once an action has succeeded the turn runs to
  completion, its narration is recorded as `not_delivered` if the caller
  hung up, and it is never re-run. An interrupted call cannot create duplicate
  appointments, leads or messages.
- **Termination.** `bye` or a closed socket ends the session through the same
  gateway path as a hang-up, so the call still reaches a terminal state with a
  disposition and a complete transcript.
- **Errors.** A non-retryable `stt` or `tts` error ends the call politely with
  the tenant's goodbye; it never produces a success narration.

---

## 4. Implementation

| File | Role | Size |
| --- | --- | --- |
| `packages/voice/media-session.ts` | the `VoiceMediaSession` seam, with a compile-time proof that `VoiceSession` satisfies it | 46 |
| `packages/voice/pipecat/protocol.ts` | the validated wire format | 193 |
| `packages/voice/pipecat/remote-session.ts` | conversation policy over reported facts | 858 |
| `packages/voice/pipecat/bridge.ts` | engine factory + socket routing | 187 |
| `services/voice-gateway/pipecat-control.ts` | the control socket (transport only) | 120 |
| `services/pipecat-worker/halo_client.py` | reference worker client — **NOT VERIFIED** | 341 |

Changes to existing files: `gateway.ts` gained an injectable
`createMediaSession` defaulting to the Phase 3 engine (~25 lines);
`server.ts` gained the `/pipecat/control` upgrade route and points the
provider at the worker when configured; `config.ts` gained `VOICE_MEDIA_ENGINE`
and `VOICE_PIPECAT_MEDIA_WS_URL`, failing closed if the second is missing;
`phone-channel-adapter.ts` accepts application-bound tool executors. **No
Phase 3 behaviour changed**, which the unchanged 782 Phase 3 tests demonstrate.

### The one duplication, and how it is controlled

`RemoteVoiceSession` re-expresses the conversation policy that `VoiceSession`
expresses over audio. The alternative — refactoring the 1,121-line file the
Phase 3 report names as the highest-risk in the codebase, where all three of
its defects lived — was judged worse.

The duplication is controlled by keeping everything shareable shared (the
session config and prompts, the state enum, the event and summary types, the
transcript types, the turn-handler contract, the sentence chunker) and by the
two engines being interchangeable behind one seam, so a behaviour they
disagree on shows up as a gateway-level test failure.

A genuine re-entrancy defect was found while testing the remote engine:
`speakPolicyThenEnd` and `end` read `this.playback` twice across a `send`
that a synchronous worker can settle in between. Fixed by capturing it first.

---

## 5. Configuration

```bash
VOICE_MEDIA_ENGINE=pipecat                        # default: in_process
VOICE_PIPECAT_MEDIA_WS_URL=wss://worker/ws        # required when pipecat
VOICE_GATEWAY_PUBLIC_WS_URL=wss://gateway/media   # origin of the control URL
VOICE_STREAM_TOKEN_SECRET=<32+ chars>
TELEPHONY_PROVIDER=twilio|fake
```

`in_process` is the default, so an existing deployment is unaffected by this
work until it opts in. A gateway configured for Pipecat without a bridge
throws at construction rather than answering calls it cannot serve.

---

## 6. Security

| Property | Mechanism | Status |
| --- | --- | --- |
| A worker cannot choose a tenant | the token is bound to `providerCallId`+`from`+`to`; tenant comes from the dialled number | MOCK-VERIFIED (test) |
| A worker cannot answer for another number | a tampered `to` fails HMAC verification (1008) | MOCK-VERIFIED (test) |
| A worker cannot claim another call | a mismatched `providerCallId` fails, and no call row is created | MOCK-VERIFIED (test) |
| Identity never travels upward | no inbound frame has an identity field; extras are dropped | MOCK-VERIFIED (test) |
| An incompatible worker is refused | protocol major version checked on `hello` | MOCK-VERIFIED (test) |
| Malformed input cannot act | every frame zod-validated; binary frames ignored; 32 KB cap | MOCK-VERIFIED (test) |
| No credential reaches the worker | `ready` asserted free of token/secret/key material | MOCK-VERIFIED (test) |
| No arbitrary URL is executed | the worker URL is env config validated as a URL; the worker supplies none | MOCK-VERIFIED (test) |
| No arbitrary provider access | provider enums admit only vetted adapters | MOCK-VERIFIED (test) |
| Transfer target never model-chosen | tenant-configured E.164; no transfer command exists on the wire | VERIFIED (source) |
| Model never controls tenant identity | `TrustedRequestContext` is built by server code only | VERIFIED (source) |
| Tenant isolation in the database | `check:rls` as real `authenticated` / `service_role` roles | VERIFIED |

**Carried forward from Phase 3 §10, unchanged:** a valid stream token replayed
inside its TTL re-attaches the session and redirects the call's audio to the
presenting socket. The Pipecat path inherits this because it inherits the
token mechanism. The recommended fix is the same — allow re-attach only while
the session is actually awaiting reconnection — and it is still deferred for
the same reason: it needs evidence about real provider and worker reconnect
behaviour that does not exist yet.

---

## 7. What is not proven

- **No real call has been placed.** Not through Pipecat, not through the
  in-process engine. Every latency figure anywhere in this repository is from
  mock providers.
- **The worker side is unverified.** `halo_client.py` has never run against a
  real pipeline; its tests prove protocol logic, not media behaviour.
- **No STT or TTS vendor has been chosen or scored**, in Telugu or otherwise.
- **Scaling is unchanged from Phase 3:** sessions are in-process and a restart
  drops live calls. Pipecat adds a second process to that story, not a
  solution to it.

The procedure that would change any of this is `docs/PHASE4_REPORT.md` §15.
