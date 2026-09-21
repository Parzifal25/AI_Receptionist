# HALO Pipecat worker (reference)

**Status: REFERENCE IMPLEMENTATION — NOT VERIFIED.**

`halo_client.py` has never been run against a real telephony provider, a real
STT or TTS vendor, or a real Pipecat pipeline, because no credentials for any
of them exist in this repository. Its protocol logic is covered by
`test_halo_client.py` (10 tests, pure Python, no network), and the other side
of the same wire is covered end to end over a real WebSocket by
`tests/integration/pipecat-gateway.test.ts`. Neither of those is a phone call.
Nothing here should be described as working until §15 of
`docs/PHASE4_REPORT.md` has been executed.

## What lives where

```
telephony provider
      │  media (μ-law 8 kHz)
      ▼
pipecat worker ────── transport, VAD, STT, TTS, interruption
      │  WSS /pipecat/control   (JSON text only, never audio)
      ▼
HALO voice gateway ── tenant, agent, agent version, call row, state machine,
      │               transcript, outcome, transfer authority
      ▼
HALO Agent Runtime ── conversation, tools, knowledge, policy, escalation
```

The worker owns the parts where milliseconds are audible. HALO owns every
part where being wrong costs the business something. The full rationale and
the frame-by-frame contract are in `docs/PIPECAT_INTEGRATION.md`.

## The three rules a worker must not break

1. **It never chooses a tenant or an agent.** It presents the short-lived
   token HALO minted during the signature-verified telephony webhook, bound to
   the call id and both numbers. Identity comes back in `ready` and is used
   for logging only.
2. **It never speaks a line HALO did not send.** Greetings, reprompts,
   goodbyes, transfer announcements and model replies all arrive as `speak`.
   The worker holds no tenant content and cannot invent or translate one.
3. **It reports what the caller actually heard.** `chunk_played` means the
   chunk left the earpiece, not that synthesis finished. HALO writes the
   transcript and the model's next-turn context from exactly those
   acknowledgements, so an optimistic report becomes a lie the agent then
   acts on.

## Wiring it into a Pipecat pipeline

`halo_client.py` is deliberately transport-only and imports no Pipecat, so it
can be tested without a media stack. A worker binds it to the pipeline:

- `on_ready(identity, voice)` — configure STT language, alternative
  languages and phrase hints; configure the TTS voice and rate; configure VAD
  from `vad_min_speech_ms` / `vad_end_hangover_ms`.
- `on_speak(request)` — synthesize `request.chunks` **in order**, emit
  `playback_first_audio` once, `playback_chunk_played(i)` as each chunk
  finishes playing out, then `playback_stopped(..., "completed")`. If
  `request.interruptible` is false (a handoff or hang-up line), do not cut it
  on caller speech.
- VAD → `speech_started` / `speech_stopped`. On caller speech during an
  interruptible playback: cut locally **first**, then
  `playback_stopped(..., "interrupted")` with the chunks already acknowledged.
- STT → `transcript(..., final=False|True)`. Send `confidence` only when the
  vendor reports one; a fabricated 0.9 silently disables HALO's read-back of
  misheard names and numbers.
- `on_hangup` → end the call leg. `on_stop_playback` → stop that playback.
- Transport gone → `bye(reason)`.

## Running the tests

```bash
cd services/pipecat-worker && python3 -m unittest discover -s .
```

## What must be measured before this is called working

See `docs/PHASE4_REPORT.md` §15. In short: a real inbound PSTN call in
Telugu, with STT latency, LLM latency, TTS time-to-first-audio, total turn
latency and interruption latency recorded per stage, plus deliberate failure
injection. Until then the integration is MOCK-VERIFIED on the HALO side and
UNVERIFIED on this side.
