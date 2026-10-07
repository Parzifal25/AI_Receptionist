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

## Browser voice

A browser can be the media peer instead of a carrier. The widget asks
`POST /api/v1/widget/voice-call`; the web server authorizes the widget and its
origin and obtains a token-bound `start` frame from the gateway's signed
`POST /web/call`. The widget then opens this worker's `/media` socket, sends
that `start`, streams microphone audio in the session's wire format and plays
what comes back. `clear` drops queued playback (barge-in) and each `mark` is
echoed once the audio before it has played. The worker treats it as any other
media session; tenant, agent and every spoken word still come from HALO.

Speech settings come from the same variables the gateway reads:
`SARVAM_API_KEY`, `VOICE_STT_MODEL`, `VOICE_STT_MODE`, `VOICE_TTS_MODEL` and
`VOICE_TTS_DEFAULT_VOICE`. The agent's primary language is pinned for STT;
`saaras:v3` with `codemix` handled Telugu, English and Tenglish in live runs.

### Running the browser loop locally

```bash
# 1. A voice-ready tenant (idempotent; prints the widget URL). Generic: the
#    tenant comes from a JSON file, see scripts/demo/voice-tenant.example.json.
npm run demo:voice-tenant

# 2. Gateway, with the media loop handed to Pipecat.
VOICE_MEDIA_ENGINE=pipecat VOICE_PIPECAT_MEDIA_WS_URL=ws://127.0.0.1:8900/media \
  npm run voice-gateway

# 3. Worker: same key and speech settings, server-side only.
( set -a; . ./.env.local; set +a
  HALO_CONTROL_URL=ws://127.0.0.1:8787/pipecat/control \
  VOICE_STT_MODEL=saaras:v3 VOICE_STT_MODE=codemix VOICE_TTS_MODEL=bulbul:v3 \
  .venv/bin/python services/pipecat-worker/worker.py )

# 4. The app, then open the URL the seed printed and tap the microphone.
npm run dev
```

The gateway, the app and the seed must all point at the same Supabase
(`NEXT_PUBLIC_SUPABASE_URL`). Outside production the app's CSP allows a
loopback `ws://` media socket; a deployed worker must be reachable over `wss://`.

Physical check, on a machine with a microphone and a speaker: grant the
microphone, wait for the greeting, then speak Telugu, English and a
Telugu-English mix and confirm each reply is audible and in a fitting language;
ask a follow-up that depends on an earlier turn; talk over a long reply and
confirm it stops and the new question is answered.

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
independently. Configured startup fallback is tested; seamless mid-call
provider migration is not implemented.

Playback acknowledgement waits for carrier marks. Interruption clears pending
marks and buffered audio; late synthesis and incomplete chunks cannot become
confirmed transcript text.

Before production activation, run the real PSTN acceptance procedure in
`docs/PHASE4_REPORT.md` §15 with authorized numbers and provider credentials.
Measure STT, LLM, first-audio and interruption latency, speech quality and
failure recovery. Real carrier and Sarvam acceptance remain **BLOCKED**
pending credentials and authorized calls.
