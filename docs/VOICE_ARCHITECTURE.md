# HALO Voice Architecture (Phase 3)

The voice foundation: a provider-neutral, real-time telephony boundary that drives the
**unchanged** Phase 2 Agent Runtime. The code is the source of truth; where this document and the
code disagree, fix the document.

**Status:** MOCK-VERIFIED. Every layer is implemented and tested against deterministic fakes and
one real provider *protocol* (Twilio Media Streams, fixtures only). No telephony, STT or TTS
vendor has been contacted from this repository — there are no credentials. See
[`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) and [`PHASE3_REPORT.md`](PHASE3_REPORT.md).

## 1. Boundary

```text
 PSTN
   │
 Telephony provider ── signed webhook ──▶ services/voice-gateway (HTTP)
   │                                        verify signature (fail closed)
   │                                        resolve DID → tenant/agent/version
   │                                        mint stream token (HMAC, ~2 min)
   │                                        answer: connect media stream
   └── media WebSocket (μ-law 8 kHz) ──▶ services/voice-gateway (WS)
                                            verify stream token on `start`
                                            provider codec ⇄ neutral events
                                                        │
                                            packages/voice/gateway.ts
                                              call identity + state machine
                                              persistence, capacity, latency
                                                        │
                                            packages/voice/voice-session.ts
                                              VAD/endpointing · barge-in
                                              silence · failure · cancellation
                                                        │
                                            packages/voice/phone-channel-adapter.ts
                                              VoiceTurnHandler ⇄ AgentRuntime
                                                        │
                                            packages/runtime (UNCHANGED loop)
                                              phone-voice ChannelProfile
                                                        │
                        ports: telephony · streaming STT · streaming TTS · LLM
```

**The Agent Runtime has no telephony dependency.** It gained exactly one additive capability in
Phase 3 — an optional `RuntimeInput.signal` — and one more channel profile. A phone turn and a web
turn differ only in the profile and the adapter.

## 2. Contracts

| Port | File | Notes |
| --- | --- | --- |
| Telephony | `packages/ports/telephony-provider.ts` | Control (verify/parse webhook, answer, reject, hangup, transfer) **and** a media-stream codec. `verifyWebhook` is on the interface so no adapter can forget it, and it fails closed when unconfigured. |
| Streaming STT | `packages/ports/streaming-stt-provider.ts` | `open(options, listener) → SttStream`; ordered events (`speech_started`, `partial`, `final`, `endpoint`, `error`, `closed`), stable `utteranceId`, confidence only when the vendor reports it. |
| Streaming TTS | `packages/ports/streaming-tts-provider.ts` | `synthesize(request, signal) → AsyncIterable<Uint8Array>`. Cancellation is mandatory — barge-in depends on it. |

Contract kits in `tests/contracts/voice-provider-contracts.ts` must pass for every adapter (fake,
reference, future vendor).

## 3. Session state machine (`voice-session.ts`)

```text
idle ─start─▶ speaking(greeting) ─▶ listening ⇄ user_speaking ─endpoint+final─▶ thinking
                   ▲                    │                                        │
                   │                    └─silence─▶ speaking(reprompt)           ▼
                   └──────────────────────────────────────────────────── speaking(reply)
  barge-in: speaking ─caller speech─▶ user_speaking   (TTS aborted, provider buffer cleared)
            thinking ─caller speech─▶ user_speaking   (turn aborted; utterances merged)
  any ─end()─▶ ending ─▶ ended
```

- **Full duplex.** Caller audio keeps reaching STT and the endpointer while the agent speaks.
- **Barge-in** needs `bargeInMinSpeechMs` of sustained speech (default 250 ms) — or a non-empty STT
  partial — so TTS bleed and clicks do not cut the agent off. On barge-in the TTS stream is
  aborted, the provider's playout buffer is cleared, and what the caller actually heard is
  recorded. `interrupt()` is idempotent.
- **Turn cancellation.** A barge-in during `thinking` aborts the runtime turn. If nothing committed,
  the turn persists nothing and the interrupted utterance is merged with the next one
  (`"my bill is" + "three thousand"` → one turn). If an action already committed, the turn finishes
  and its reply is recorded as **not heard** — business state and transcript never disagree.
- **Silence** budget: reprompt up to `maxSilentReprompts`, then a goodbye and hang-up.
- **Failures** are bounded: one STT reconnect, one TTS retry before first byte, a turn timeout, a
  guard against handlers that ignore their abort signal, and a ceiling on consecutive turn
  failures. The session only ever speaks a handler reply or a tenant-authored policy line — it
  never improvises and never claims success.
- Every buffer, queue, retry and loop has an explicit bound (`VoiceSessionConfig`).

## 4. Call lifecycle (`gateway.ts`, migration 0020)

Technical state (`calls.state`) and business outcome (`conversation_outcomes.disposition`) are
**separate** (plan §P5.4): a `completed` call can be `not_interested`; a `no_answer` call has no
outcome.

```text
created ─▶ queued ─▶ dialing ─▶ ringing ─▶ connected ─▶ in_conversation ─▶ completing ─▶ completed
                                                             │  ▲              ▲
                                                             ▼  │              │
                                                        interrupted ───────────┤
                                                             └──▶ transferred / failed / …
```

The graph lives in `packages/voice/call-state.ts` **and** in the 0020 trigger (a parity test keeps
them identical), so terminal protection holds even for the service role and a late provider webhook
cannot resurrect a finished call.

Per call the gateway writes: a `calls` row (pinned to the agent **version**), the `call_events`
stream with per-stage latencies, turn-level `call_transcript_turns` (speaker, language, STT
confidence, delivery status), one `conversation_outcomes` row, and `call_started` / `call_completed`
usage events. Telemetry is buffered and flushed; a persistence failure is logged and never fails a
call. **A dropped call still produces a finalized call row, a transcript and an outcome.**

## 5. Trust and tenancy

| Concern | Mechanism |
| --- | --- |
| Tenant identity | `resolveInboundRoute(provider, dialledNumber)` → `phone_numbers` → agent → live version. Never from a provider payload, a caller, or the model. |
| Webhook authenticity | `verifyWebhook` per adapter, constant-time, **fail closed** when no secret is configured (503, route disabled). |
| Media socket | A WebSocket upgrade carries no provider signature, so the gateway mints a short-lived HMAC **stream token** during the verified webhook, bound to the provider call id *and* both numbers; the `start` frame must present it. Tampering with the dialled number invalidates the token. Frames before a verified `start` are dropped. |
| Transfer target | `phone_numbers.handoff_number` (tenant configuration, E.164-checked in the schema). The model can request a handoff; it can never choose a destination. A transfer is announced by a deterministic line and attempted at most once per call. |
| Model authority | Unchanged from Phase 2: closed tool registry, schema-validated arguments, act-then-narrate enforced by the validator. On phone, a `handoff` claim is only permitted when a live transfer is actually available. |
| Cross-tenant writes | Every store call is explicitly tenant-scoped, and the 0020 ownership triggers re-check agent, version, conversation, phone number and call tenancy in the database. |
| Credentials | Only the gateway process holds provider credentials. Nothing reaches a client. |

## 6. The gateway process

`services/voice-gateway` is the plan's single process separation (§2.1): a minutes-long, stateful,
latency-critical audio session is the wrong shape for serverless request/response.

| Route | Purpose |
| --- | --- |
| `POST /telephony/:provider/inbound` | Verified webhook → routing + voice-config check → media-stream answer with the stream token, or a polite reject. |
| `POST /telephony/:provider/status` | Verified status callbacks → call state. |
| `GET /health` | Liveness, live session count, provider (drains with 503). |
| `WS /media` | Bidirectional audio. |

Configuration fails closed (`config.ts`): no stream-token secret or no provider signing secret ⇒ the
process does not start. `SIGTERM`/`SIGINT` drain: stop accepting, end every live session (each call
is finalized with `gateway_shutdown`), close sockets.

**An agent without tenant-authored voice prompts is never answered.** The greeting carries the AI
disclosure, and the platform will not invent or translate one (`session-config.ts`); the call is
declined instead.

### Deployment notes

- Sessions are in-memory: the media socket for a call must reach the instance that answered its
  webhook. Run a single instance, or route by the call id / use sticky sessions. This is a
  documented limitation, not a design intent.
- The gateway is **not** a Vercel function; it is a long-lived Node process (Fly/Railway/ECS).
- Recording is not implemented. The `calls.recording_ref` / `recording_consent_at` columns exist
  with a CHECK that a recording cannot be stored without consent (plan §P5.8).

## 7. Latency

Measured with `npm run voice:latency` (mock vendors — a real budget needs the §P4 evaluation):

| Stage (mock profile: STT 250 ms, model 600 ms, TTS first byte 200 ms) | p50 | p95 |
| --- | ---: | ---: |
| `endpoint` (local VAD hangover, configured 400 ms) | 400 | 400 |
| `stt_final` (endpoint → final transcript) | 198 | 205 |
| `agent_turn` (transcript → validated reply) | 604 | 608 |
| `tts_first_byte` (reply → first audio byte) | 202 | 209 |
| `turn_complete` (end of speech → first audio byte) | 1007 | 1014 |
| `tts_cancel` (barge-in detected → playout cleared) | 1 | 1 |

HALO's own overhead inside a turn is ≈ 3 ms; everything else is the injected vendor profile. The
plan's §P4.3 acceptance targets (p50 ≤ 1200 ms, p95 ≤ 2000 ms end-to-end) **cannot** be confirmed
without real vendors and a real phone line.

## 8. What Phase 3 deliberately does not do

- No vendor selection, no live Telugu STT/TTS, no PSTN test (plan §P4 gate: BLOCKED).
- No outbound dialler or campaigns, no DNC registry integration (internal suppression only).
- No call recording or recording storage.
- No warm-transfer whisper context (the transfer is a blind bridge to the configured number).
- No multi-instance session affinity, no distributed session store.
- No SSE streaming of model tokens into TTS: the validator must see the whole reply before it is
  spoken (act-then-narrate). Sentence chunking starts audio at the first sentence.

## 9. Validation

```bash
npm test                        # unit + integration (voice session, gateway, service, contracts)
npm run check:architecture      # runtime/voice boundaries, RLS on every table
npm run check:migrations        # 0020 applies to a fresh database
npm run check:rls               # tenant isolation + voice triggers as real database roles
npm run voice:latency           # per-stage latency with mock vendors
npm run voice-gateway           # run the process (fails closed without configuration)
```
