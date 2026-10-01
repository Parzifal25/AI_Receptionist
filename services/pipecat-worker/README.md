# HALO Pipecat worker (reference)

**Status: DONE — MOCK VERIFIED for local integration; live carrier and speech acceptance BLOCKED.**

The worker runs a real Pipecat pipeline and Silero VAD in the local end-to-end
suite, using synthetic audio, fake STT/TTS and WebSocket carrier/control peers.
All 37 Python tests passed on October 1, 2026. This verifies pipeline and protocol
behavior, not a real phone call or provider speech quality. See
[`HALO_IMPLEMENTATION_VERIFICATION.md`](../../docs/HALO_IMPLEMENTATION_VERIFICATION.md)
for repository-wide evidence and remaining deployment requirements.

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
   the call id and both numbers. Identity comes back in `ready` and selects only the tenant-scoped
   deployment voice profile; it never grants business authority.
2. **It never speaks a line HALO did not send.** Greetings, reprompts,
   goodbyes, transfer announcements and model replies all arrive as `speak`.
   The worker holds no tenant content and cannot invent or translate one.
3. **It reports carrier-confirmed playback.** `playback_chunk_played` requires
   completed synthesis and a matching carrier mark echoed after queued audio.
   This is a transport acknowledgement, not proof of human hearing. HALO writes the
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

## Installing dependencies

From the repository root, use Python 3.10 or newer to create a local
environment and install the worker dependencies:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r services/pipecat-worker/requirements.txt
```

The environment is ignored by Git. Dependencies are installed locally rather
than committed to the repository.

## Running the tests

```bash
.venv/bin/python -m unittest discover -s services/pipecat-worker
```

## Deployment configuration and acceptance

Set `HALO_CONTROL_URL` to the trusted control WebSocket endpoint. Carrier-supplied
control URLs must match it exactly. Fake speech requires explicit
`HALO_SPEECH_PROVIDER=fake`; missing real-provider credentials fail safely.
`VOICE_PROFILES_JSON` must match the gateway's tenant/profile mapping. Keep
credentials in deployment configuration, never in the control protocol.

The Twilio transport uses its 8 kHz mono μ-law wire format. Provider profiles
must support that transport's rate; other adapter formats are configured
independently. Self-hosted speech adapters implement HTTP contracts suitable
for separately deployed IndicConformerASR/IndicF5 services. Model weights and
inference servers were not installed or validated. Configured startup fallback
is tested; seamless mid-call provider migration is not implemented.

Playback acknowledgement waits for carrier marks. Interruption clears pending
marks and buffered audio; late synthesis and incomplete chunks cannot become
confirmed transcript text.

Before production activation, run the real PSTN acceptance procedure in
`docs/PHASE4_REPORT.md` §15 with authorized numbers and provider credentials.
Measure STT, LLM, first-audio and interruption latency, speech quality and
failure recovery. Real carrier, Sarvam and local-model acceptance remain
**BLOCKED** pending credentials, endpoints/model weights and authorized calls.
