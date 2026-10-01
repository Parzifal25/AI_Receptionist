# Web microphone/STT diagnosis — October 1, 2026

## Exact original runtime path and failure

The dashboard playground and demo embed the same `public/widget.js` bundle.
`widget/src/widget.ts` instantiated `BrowserSpeechProvider` unconditionally.
Its permission preflight called `getUserMedia`, released the track, then
`startRecognition` constructed `window.SpeechRecognition` or
`window.webkitSpeechRecognition`. Browser-generated text went to the existing
widget message API. Audio never reached HALO's gateway or Pipecat.

The quoted error is the widget's mapping for a Web Speech `network` error after
bounded retries. It identifies the failing implementation, not the underlying
browser vendor/network cause. No browser console/network trace was available to
identify why that external browser service failed. This error is distinct from
permission denial (`not-allowed`) or missing/busy hardware (`audio-capture`).
Sarvam and self-hosted STT were not involved in that failure.

Independent deployment inspection found the local gateway unreachable at
127.0.0.1:8787 even outside the network sandbox. STT selection, gateway URL,
stream signing secret, Sarvam credentials and self-hosted endpoint were unset.
Only variable presence was inspected; credentials were not printed.

## Corrected path

```
Microphone permission -> Web Audio capture at hardware sample rate
 -> filtered Web Audio resampling -> mono PCM16LE at 16,000 Hz
 -> POST /api/v1/widget/speech (bounded utterance)
 -> widget/origin/voice-enabled checks and per-IP/tenant rate limits
 -> signed server-to-server POST /web/stt on the HALO voice gateway
 -> existing StreamingSttProvider factory and configured fallback
 -> provider final transcript -> existing widget messages/AgentRuntime path
 -> existing browser speech synthesis for web playback
```

There is no browser-recognition fallback. Missing configuration, provider errors,
permission denial and network failure produce errors, never simulated text.
The public web endpoint refuses fake STT providers. Provider credentials never
reach the browser. Tenant and language are resolved server-side from the widget,
not accepted as audio-request overrides. The gateway verifies a domain-separated
HMAC and short request age; audio length, concurrency and processing time are
bounded. Errors log classifications without raw audio, transcripts or credentials.

This is the web speech accessory through the existing provider seam, not a new
phone session. Pipecat's telephony media/control path is unchanged. The web route
uses the gateway's deployment STT defaults; it does not select a phone agent's
voice profile. Browser TTS is retained explicitly, not introduced as a fallback.

## Audio and endpoint contract

Capture uses the actual AudioContext rate (commonly 44.1/48 kHz), mono input and
browser echo cancellation. OfflineAudioContext resamples to 16 kHz. Samples are
clipped and encoded as signed 16-bit little-endian PCM; WebM/Opus is never passed
off as PCM. Recording ends after speech plus 900 ms silence, or eight seconds.
The server accepts at most ten seconds and paces 20 ms provider frames to respect
existing startup buffering. This is bounded utterance capture, not full-duplex
browser streaming.

Sarvam web sessions select manual endpointing and send speech_start, audio_input
and flush. Phone sessions keep their existing VAD setting. English/Hindi widget
language tags resolve to the provider's declared regional code; unsupported
languages fail rather than switching languages. Sarvam accepts mono linear16 at
8/16 kHz on this endpoint; see the [official realtime protocol](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming).
Self-hosted STT receives the existing JSON/base64 PCM contract with explicit
encoding, sample rate and channel count. Telephony's 8 kHz μ-law boundary is
unchanged and is not used by this web input path.

## Required local configuration

On the Next server, set `VOICE_GATEWAY_INTERNAL_URL=http://127.0.0.1:8787` and
`VOICE_STREAM_TOKEN_SECRET` to the same secret used by the gateway (at least 32
characters). These are server-only variables. Do not expose them with NEXT_PUBLIC.

Configure the existing gateway as documented in `services/voice-gateway/README.md`.
For a local web test, the existing fake *carrier* can be used, but STT must be real:

- `VOICE_STT_PROVIDER=sarvam` and `VOICE_STT_API_KEY`, or
- `VOICE_STT_PROVIDER=self-hosted` and `VOICE_STT_BASE_URL` pointing to an actual
  inference service implementing `/transcribe`.

`VOICE_STT_FALLBACK_BASE_URL` retains the existing explicit fallback configuration.
The Node gateway consumes `VOICE_STT_API_KEY`; the Python worker's separate
`SARVAM_API_KEY` is not a substitute for that setting.

Load local env explicitly when launching the gateway:

```sh
node --env-file=.env.local --import tsx --conditions react-server services/voice-gateway/main.ts
```

Rebuild the widget (`npm run build:widget`) and restart Next after environment
changes. Open localhost or HTTPS, grant the embedding page microphone permission,
and speak a short utterance. Inspect the `/api/v1/widget/speech` response and safe
gateway error code. An iframe also needs its embedding Permissions-Policy/allow
configuration to permit microphone use. Do not interpret HTTP health or a mock
transcript as proof that a live speech service recognized audio.

## Verification and current limits

Regression coverage includes microphone denial, secure-context checks, hardware
rate resampling/PCM byte order, no browser recognition invocation, signed request
integrity/expiry, tenant/origin authorization, provider failures, cancellation,
Sarvam manual endpointing and actual local HTTP transport to a mock STT service.
Existing gateway/Pipecat WebSocket integration tests were rerun.

Executed checks: full regression suite **1,197 tests / 123 files passed**;
production build, typecheck, lint, architecture and neutrality checks passed.
The build initially hit sandbox restrictions fetching the existing Google font;
it passed when rerun with network access. The final delayed-handshake buffer
adjustment was followed by the targeted speech suites and typecheck/lint.
No real-provider success is inferred from these results.

No physical audio device (`/dev/snd`) or controllable browser session is available
in this execution environment. No Sarvam key or live self-hosted STT endpoint is
configured. An actual microphone/audio-sample-to-live-transcript test is therefore
BLOCKED, and STT is not claimed WORKING.

| Component | Status | Evidence/limit |
|---|---|---|
| BROWSER MIC | BLOCKED | Capture/permission/resampling mocks verified; no physical browser microphone available |
| HALO VOICE GATEWAY | MOCK VERIFIED | Signed web-audio HTTP and existing socket tests pass; configured local instance absent |
| PIPECAT | MOCK VERIFIED | Existing control WebSocket regressions pass; not invoked by web mic |
| STT PROVIDER | MOCK VERIFIED | Exact audio bytes reach mock inference over HTTP and its transcript returns; no live inference |
| SARVAM | BLOCKED | No credential; protocol tests pass, no audio sent to live Sarvam |
| TTS | BLOCKED | Existing browser synthesis retained; no browser speaker session available for audible verification |
