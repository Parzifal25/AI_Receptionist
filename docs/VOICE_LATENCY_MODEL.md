# HALO Voice — Latency Model (Phase 3)

No invented numbers. Every figure below is either a **configured constant** or a
**measured harness output**, and each is labelled as such. Real vendor and PSTN
latency is **NOT MEASURED** — no credentials exist (see §5).

## 1. Timing points

Marks emitted by the session as `CallEventType`s, correlated per call and turn:

| Mark | Event | Meaning |
| --- | --- | --- |
| **T0** | (media frame) | caller audio received by the gateway |
| **T1** | `speech_started` | speech detected (local energy VAD, or STT) |
| **T2** | `stt_final` | final transcript available; latency measured from end-of-speech |
| — | `endpoint` | end-of-speech decided (local VAD hangover, or STT `endpoint`) |
| **T3** | `agent_turn` (start) | Agent Runtime invoked |
| **T4** | `agent_turn` | runtime returned a validated reply + directive |
| **T5** | `tts_start` | synthesis requested |
| **T6** | `tts_first_byte` | first synthesized audio byte sent to the provider |
| **T7** | `tts_complete` | playback finished (mark-acked, or watchdog by audio duration) |
| — | `turn_complete` | **end-of-speech → first audio byte**: the span HALO owns |
| — | `barge_in` / `tts_cancel` | interruption detected → synthesis aborted and buffer cleared |

`turn_complete` is the headline metric because it is the only span the platform
is fully responsible for. It deliberately **excludes** PSTN transport and the
providers' own processing.

## 2. Measured — mock providers

`npm run voice:latency` (`scripts/voice-latency-harness.ts`), 20 calls × 5 turns,
deterministic fakes with configured delays (STT final 250 ms, model 600 ms, TTS
first byte 200 ms). Node v22.22.2. Run 2026-09-21.

| Stage | n | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| `endpoint` | 100 | 400 | 400 | 400 |
| `stt_final` | 100 | 203 | 209 | 212 |
| `agent_turn` | 100 | 602 | 607 | 612 |
| `tts_first_byte` | 120 | 202 | 206 | 211 |
| **`turn_complete`** | 100 | **1,008** | **1,017** | **1,021** |
| `tts_complete` | 20 | 768 | 770 | 771 |
| **`tts_cancel` (barge-in)** | 80 | **0** | **1** | **2** |
| `caller_turn_wall_ms` | 100 | 1,355 | 1,366 | 1,369 |

**What this does and does not show.** It measures **HALO's own overhead**: the
orchestration between the stages, not the stages themselves. `turn_complete`
(1,008 ms) is almost exactly the sum of the injected delays
(203 + 602 + 202 = 1,007 ms), so the session adds **~1 ms** of coordination
overhead per turn. That is the real result here — the platform is not the
bottleneck; the providers will be.

**Interruption latency is the other real result.** `tts_cancel` at p50 0 ms /
p95 1 ms / max 2 ms is genuine: it is the time from detecting caller speech to
aborting synthesis and clearing the provider's playout buffer, and it involves
no mock delay. Barge-in is effectively instantaneous in-process; what the caller
perceives will be dominated by however much audio the provider has already
buffered downstream.

The `endpoint` value (400 ms) is the **configured** VAD hangover, not a
measurement.

## 3. Budget for a real deployment

Derived by substituting realistic vendor figures into the measured structure.
These are **projections, not measurements**:

| Stage | Assumption | Notes |
| --- | --- | --- |
| End-of-speech hangover | 400 ms (configured) | tunable; trades responsiveness against clipping |
| Streaming STT final | 150–400 ms | vendor-dependent |
| Agent Runtime | 400–900 ms | dominated by model TTFT; see `VOICE_TOKEN_BUDGET.md` |
| TTS first byte | 100–300 ms | streaming vendors only |
| HALO coordination | ~1 ms (measured) | negligible |
| **End-of-speech → first audio** | **~650–1,600 ms** | plus PSTN transport (~50–150 ms each way) |

The target for natural conversation is ≲1,000 ms from end-of-speech to first
audio. That is achievable only with a streaming STT, a streaming TTS and a fast
model — which is precisely why all three are behind cancellable streaming ports.

## 4. What may overlap, and what must not

**Safe to overlap (implemented):**

- Caller audio → STT **while the agent is speaking**. Full duplex is what makes
  true barge-in possible.
- **Sentence-chunked synthesis**: the reply is split so audio starts on the first
  sentence instead of the whole reply (`sentence-chunker.ts`).
- Persistence (events, transcript turns) is written off the critical path and
  never blocks audio.

**Deliberately NOT overlapped (correctness over latency):**

- **Speculative generation before the final transcript.** Starting a turn on a
  partial would create turns the caller never actually completed, and burn
  tokens on utterances that change mid-flight.
- **Tool execution overlapping the next turn.** Turns are strictly serialized;
  parallel turns would race conversation state and could duplicate business
  actions.
- **Synthesizing the next reply while the current one plays.** At most one
  playback is active, by construction.
- **Narrating before confirmation.** Act-then-narrate is never traded for
  latency: the agent does not say "booked" until booking succeeded.

## 5. NOT MEASURED — blocked

Real end-to-end latency requires a live telephony leg, a real STT and a real TTS.
**No credentials exist for any of the three**, so the following are honestly
unmeasured, not estimated:

- PSTN/media transport latency
- real STT partial and final latency (and for Telugu/Tenglish specifically)
- real TTS time-to-first-byte
- real model TTFT under production prompt sizes
- perceived barge-in latency including the provider's downstream buffer
- p50/p95 over real calls

The validation procedure that would produce these numbers is in
`docs/PHASE3_REPORT.md` §Real-provider validation. Until it runs, live latency is
**BLOCKED**, not "unknown but probably fine".
