# The local voice loop

A real microphone and a real speaker on the ends of a real HALO call, on one
laptop.

```
mic ─▶ resample 8 kHz ─▶ μ-law ─▶ /media ─▶ VoiceGateway ─▶ VoiceSession
                                                                  │
                                    STT ◀────────────────────────┤
                                     │                            │
                              Agent Runtime ─▶ LLM ─▶ validator ──┤
                                                                  │
   speaker ◀── μ-law ◀── /media ◀────────────────────── TTS ◀─────┘
```

**This is development infrastructure.** `scripts/local-call.ts` is a laptop
pretending to be a phone carrier: it speaks the protocol
`FakeTelephonyProvider` already defines, so the gateway code path is the
production one. It adds no server, no second voice path and nothing under
`packages/`.

**It proves vendors, the model, Telugu behaviour and real latency. It proves
nothing about telephony** — no PSTN transport, no carrier jitter, no packet
loss, no Pipecat worker. A good demo here is not a working phone call. See
[`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md).

---

## 1. Requirements

**Operating system.** Linux, macOS or Windows. WSL2 needs a working audio
stack (WSLg, or PulseAudio forwarded to Windows); a bare WSL2 install has no
audio devices and the client will fail to start its recorder.

**Audio tools.** The client shells out to a recorder and a player rather than
pulling a native audio module into the repository. Install one:

| Platform | Install | Notes |
| --- | --- | --- |
| Debian/Ubuntu/WSL | `sudo apt install sox libsox-fmt-all` | the default; `rec`/`play` built in |
| macOS | `brew install sox` | grant Terminal microphone access |
| Fedora | `sudo dnf install sox` | |
| Any | `ffmpeg` or ALSA `arecord`/`aplay` | override the commands, below |

**Microphone permission.** macOS prompts on first run (System Settings →
Privacy & Security → Microphone). Linux needs your user in `audio`. Check
capture works before blaming HALO:

```bash
sox -d -t raw -b 16 -e signed-integer -r 48000 -c 1 - | head -c 96000 > /dev/null
```

**Speaker.** Anything the player can open. `sox`'s `-d` output uses the
system default device.

---

## 2. What must already exist

The gateway refuses calls it cannot serve honestly, so all of this is
required before the client will get past the webhook:

1. A **tenant** with an **active agent** and a **published version**.
2. That version carries all six voice prompts (`greeting`, `reprompt`,
   `goodbye`, `turnFailure`, `transferAnnounce`, `transferFailed`), in the
   agent's own language. A missing prompt means the call is declined rather
   than answered with an invented line.
3. A **`phone_numbers` row** binding a number to that tenant, agent and
   version. Service-role only — a tenant cannot claim a DID.

For the Arunodhaya demo tenant: `npx tsx scripts/demo/arunodhaya.ts seed`.

```sql
insert into phone_numbers (business_id, agent_id, provider, e164, handoff_number, label)
values ('<business>', '<agent>', 'fake', '+914000000001', null, 'Local loop');
```

The provider column must be `fake`: that is the carrier the client pretends
to be.

---

## 3. Environment

### Gateway

```bash
export VOICE_GATEWAY_PUBLIC_WS_URL=ws://127.0.0.1:8787/media
export VOICE_STREAM_TOKEN_SECRET=$(openssl rand -hex 32)   # ≥32 chars
export VOICE_FAKE_WEBHOOK_SECRET=$(openssl rand -hex 16)   # ≥16 chars
export TELEPHONY_PROVIDER=fake
export VOICE_GATEWAY_PORT=8787

# Supabase + the model, exactly as the app uses them
export NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
export LLM_PROVIDER=anthropic LLM_API_KEY=... LLM_MODEL=...

# Real speech vendors. Omit all six to run the loop with the fakes first.
export VOICE_STT_PROVIDER=sarvam
export VOICE_STT_API_KEY=...
export VOICE_STT_MODE=transcribe          # or codemix, for mixed-script output
export VOICE_TTS_PROVIDER=sarvam
export VOICE_TTS_API_KEY=...
export VOICE_TTS_DEFAULT_VOICE=<speaker>  # no default: you choose the voice
```

Selecting a real vendor without its credential (or TTS without a voice) is a
**startup failure**, not a runtime surprise. A gateway that answers a call it
cannot speak is worse than one that refuses to boot — the caller is already
on the line by the time anyone finds out.

For the model, prefer a hosted provider that declares `{streaming: true,
tools: true}`. With `LLM_PROVIDER=gemini` the agent is offered no tools and
cannot stream, so there is no `llm_first_token` mark.

### Client

```bash
export VOICE_FAKE_WEBHOOK_SECRET=...   # the SAME value the gateway is running with
export HALO_LOCAL_FROM=+919800000001   # who you are calling from
export HALO_LOCAL_TO=+914000000001     # the provisioned number
```

Optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HALO_LOCAL_GATEWAY` | `http://127.0.0.1:8787` | gateway base URL |
| `HALO_LOCAL_CAPTURE_RATE` | `48000` | mic rate before resampling |
| `HALO_LOCAL_MIC_CMD` | `sox …` | recorder; must write **raw PCM16LE mono** to stdout |
| `HALO_LOCAL_SPEAKER_CMD` | `sox …` | player; must read **raw PCM16LE mono 8 kHz** from stdin |

ALSA instead of sox:

```bash
export HALO_LOCAL_MIC_CMD="arecord -q -f S16_LE -r 48000 -c 1 -t raw"
export HALO_LOCAL_SPEAKER_CMD="aplay -q -f S16_LE -r 8000 -c 1 -t raw"
```

ffmpeg on macOS:

```bash
export HALO_LOCAL_MIC_CMD="ffmpeg -loglevel error -f avfoundation -i :0 -ac 1 -ar 48000 -f s16le -"
```

---

## 4. Run it

Two terminals.

```bash
# 1 — the gateway
npm run voice-gateway

# 2 — the call
npx tsx scripts/local-call.ts --from +919800000001 --to +914000000001
```

You should hear the agent's greeting. Speak; stop; wait. Flags override the
environment: `--gateway`, `--public-url`, `--from`, `--to`, `--capture-rate`,
`--help`.

**Ending a session.** `Ctrl-C`. The client sends `stop` on the media socket
and posts a `completed` status webhook, exactly as a carrier would, so the
call is finalized instead of ageing out against its duration ceiling. Then it
prints its latency table.

Stopping the gateway with `SIGTERM` drains: every live call is ended and
finalized (`gateway_shutdown`) before exit.

---

## 5. Reading the latency

The client prints only what the gateway cannot see: speech duration, and
end-of-speech to audio actually reaching the speaker. Everything else is in
`call_events` for that call:

| Mark | Meaning |
| --- | --- |
| `speech_started` | caller began speaking |
| `endpoint` | end of speech detected (local VAD or the vendor's) |
| `stt_final` | final transcript, measured from end of speech |
| `context_ready` | model context assembled, first model call going out |
| `llm_first_token` | first usable model output — **only if the provider streamed** |
| `tts_first_byte` | first synthesized audio |
| `turn_complete` | end of speech → first audio on the wire |

```sql
select type, latency_ms, detail
from call_events
where call_id = '<call>' and latency_ms is not null
order by seq;
```

A missing `llm_first_token` is information: that provider did not stream. It
is never filled in with an estimate, and `agent_turn.firstTokenMs` is
explicitly `null` in that case.

The client's number includes local capture, its own resampling and the
speaker's buffering, and contains no PSTN transport. It is a local-loop
measurement, not a phone-call latency.

---

## 6. Audio format

The media contract is **base64 μ-law 8 kHz mono, JSON lines** — the shape
real media-stream vendors use, which is why the gateway path is identical.
Frames are 20 ms (160 bytes).

The microphone runs at 44.1/48 kHz, so something has to resample. It happens
**in the client**, never in `packages/voice/audio.ts`: the media contract is
not negotiable because of the hardware on one desk. The client averages each
output sample's input window — a box low-pass, crude next to a windowed-sinc,
but it removes the aliasing a bare take-every-Nth-sample decimation would
fold into the speech band.

---

## 7. Troubleshooting

| Symptom | Cause |
| --- | --- |
| `local-call needs: …` | Missing secret or numbers. There is no default for either number: which tenant answers is a routing fact the script must not invent. |
| `gateway refused the call: 403` | `VOICE_FAKE_WEBHOOK_SECRET` differs between the two terminals, or the gateway's `VOICE_GATEWAY_PUBLIC_WS_URL` differs from the client's `--public-url`. The signature covers the URL. |
| `gateway refused the call: 503` | The gateway has no webhook secret configured, or is draining. |
| `gateway declined: unknown_number` | The dialled number is not in `phone_numbers`, the agent is not active, it has no published version, or that version is missing voice prompts. The gateway log names the missing keys. |
| `media socket closed by the gateway: 1008` | Stream token rejected — expired (120 s default), or the call id did not match. Place the call again. |
| `media socket closed by the gateway: 1011` | Session refused: the concurrency ceiling, or routing failed after the webhook. |
| `microphone failed to start (sox)` | sox is not installed, or no capture device. Install it, or set `HALO_LOCAL_MIC_CMD`. |
| `[microphone] … no default audio device` | WSL2 without an audio stack, or a container with no device passthrough. |
| Greeting plays, then nothing | STT is not producing finals. With `VOICE_STT_PROVIDER=fake` that is expected — the fake transcribes nothing. Use a real vendor. |
| Agent replies to silence | The endpointer's `speechThreshold` is below your room noise. Tune `voice.endOfSpeechMs` and the threshold on the agent version. |
| Agent talks over you | Barge-in needs sustained speech. Some tail is unavoidable locally: audio already handed to the OS cannot be un-written. |
| `stt provider error … auth` | Vendor key rejected. Auth failures are deliberately not retried. |
| `tts socket closed before any audio` | The vendor accepted the text and produced nothing. Check the voice name against the model. |

---

## 8. The smoke set

`tests/fixtures/voice-smoke-utterances.ts` has eight things a caller does —
greeting, solar inquiry, electricity bill, price, appointment, callback,
WhatsApp, objection — each in English, Telugu and Tenglish, with what to
watch for. Say them into the call and write down what happened.

Every Telugu and Tenglish line is drawn from text already in this repository
(the Arunodhaya qualification questions, the objection cue lists, the
pending-fact questions) or is a neutral utterance with no business content.
**No Arunodhaya fact is invented**, because every one of them is currently
`supplied_pending` — there is no verified price, subsidy or warranty here to
build an utterance around.

Record three things separately, and never let them collapse into one:

| | Question | Who answers it |
| --- | --- | --- |
| **heard** | What transcript did HALO actually receive? | the logs |
| **behaviour** | Did the reply do the right thing? | you |
| **spoke** | Did the Telugu sound like a person? | a native listener, on real audio |

Two utterances are worth more than the other six:

- **price** — every Arunodhaya fact is `supplied_pending`, so the agent must
  say it does not have the figure and offer a person. *Any* number, including
  a range or a "typically around", is a failure, and it is the failure that
  costs a real customer real money.
- **appointment** — act-then-narrate. "Booked" may only be said after the
  scheduling tool actually succeeded. If it failed, the spoken reply must say
  so.

## 9. Running it with the fakes first

Before spending vendor credits, run the whole path with
`VOICE_STT_PROVIDER=fake` and `VOICE_TTS_PROVIDER=fake` (the defaults). The
call connects, the greeting plays as tone-shaped audio and hang-up
finalizes — which proves the routing, the tenant, the prompts, the token and
your audio devices. Only the transcription and the voice are missing. If that
does not work, a real vendor will not fix it.
