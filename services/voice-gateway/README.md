# services/voice-gateway

The HALO voice gateway: the only process separation in the platform (plan §2.1). It owns the media
path for phone calls and calls the Agent Runtime over an in-process interface; it holds no business
logic.

Architecture, trust model and limitations: [`docs/VOICE_ARCHITECTURE.md`](../../docs/VOICE_ARCHITECTURE.md).

## Run

```bash
npm run voice-gateway
```

Configuration is validated at startup and **fails closed** (`config.ts`):

| Variable | Required | Meaning |
| --- | --- | --- |
| `VOICE_GATEWAY_PUBLIC_WS_URL` | yes | Public `wss://` URL the provider is told to stream to (also the base used to verify webhook signatures). |
| `VOICE_STREAM_TOKEN_SECRET` | yes (≥32 chars) | HMAC key for media-socket stream tokens. |
| `VOICE_STREAM_TOKEN_TTL_MS` | no (120000) | Stream-token lifetime. |
| `TELEPHONY_PROVIDER` | yes | `twilio` (reference adapter) or `fake` (deterministic, for local/demo). |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | with `twilio` | Account + webhook signing key. |
| `VOICE_FAKE_WEBHOOK_SECRET` | with `fake` | Signing key for the fake provider (≥16 chars). |
| `VOICE_STT_PROVIDER` | no (`fake`) | `fake` or `sarvam`. A real vendor requires its credential below, or the process refuses to start. |
| `VOICE_STT_API_KEY` | with a real vendor | Vendor credential. Server-side only; never reaches a browser or a URL. |
| `VOICE_STT_MODEL`, `VOICE_STT_MODE`, `VOICE_STT_BASE_URL` | no | Vendor model, output mode (`transcribe`\|`verbatim`\|`translit`\|`codemix`) and endpoint override. |
| `VOICE_TTS_PROVIDER` | no (`fake`) | `fake` or `sarvam`. |
| `VOICE_TTS_API_KEY` | with a real vendor | Vendor credential. |
| `VOICE_TTS_DEFAULT_VOICE` | with a real vendor | Voice used when an agent version sets no `voice.ttsVoice`. **No default** — which voice a tenant's callers hear is a decision, not a fallback. |
| `VOICE_TTS_MODEL`, `VOICE_TTS_BASE_URL` | no | Vendor model and endpoint override. |
| `VOICE_MAX_CONCURRENT_SESSIONS` | no (50) | Hard ceiling on live calls in this process. |
| `VOICE_GATEWAY_PORT` | no (8787) | Listen port. |

Supabase credentials come from the shared platform env (`NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`) exactly as the app uses them.

Selecting a real vendor is a configuration decision, **not a quality claim**: no
vendor has been exercised against its live endpoint from this repository, so Telugu
accuracy, voice quality and real latency remain unmeasured
([`KNOWN_LIMITATIONS.md`](../../docs/KNOWN_LIMITATIONS.md)).

## Running a call on this laptop

`scripts/local-call.ts` puts a real microphone and speaker on a real call over the
fake-carrier protocol — the fastest way to hear what a change actually does. It is
development infrastructure and proves nothing about telephony:
[`docs/LOCAL_VOICE_LOOP.md`](../../docs/LOCAL_VOICE_LOOP.md).

## Provisioning a number

`phone_numbers` is platform-provisioned (service role only — a tenant cannot claim a DID):

```sql
insert into phone_numbers (business_id, agent_id, provider, e164, handoff_number, label)
values ('<business>', '<agent>', 'twilio', '+91XXXXXXXXXX', '+91YYYYYYYYYY', 'Main line');
```

The agent must be `active`, have a published live version, and that version must contain the voice
prompts (greeting with AI disclosure, reprompt, goodbye, turn-failure, transfer announce/failed).
Otherwise the gateway declines the call instead of answering with an invented line.

Point the provider's voice webhook at `POST https://<host>/telephony/<provider>/inbound` and its
status callback at `POST https://<host>/telephony/<provider>/status`.

## Operational notes

- Sessions live in this process's memory: route a call's media socket to the instance that answered
  its webhook (single instance or sticky routing).
- `GET /health` reports `ok` / `draining` and the live session count.
- `SIGTERM` drains: every live call is ended and finalized (`gateway_shutdown`) before exit.
