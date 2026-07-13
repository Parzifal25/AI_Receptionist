# API Reference

All application data access for the dashboard happens through Server Components and Server
Actions under RLS — there is no private REST API. The endpoints below are the **public widget
API** consumed by `widget.js`, plus health.

## Conventions

- Envelope: success → `{ "data": ... }`, failure → `{ "error": { "code", "message", "details?" } }`
- Error codes: `VALIDATION_ERROR` 400 · `UNAUTHORIZED` 401 · `FORBIDDEN` 403 · `NOT_FOUND` 404 ·
  `CONFLICT` 409 · `RATE_LIMITED` 429 · `PROVIDER_ERROR` 502 · `INTERNAL_ERROR` 500
- CORS: every endpoint answers `OPTIONS` preflights. If the business configured allowed
  domains, other origins receive `FORBIDDEN`.
- Rate limits (per IP unless noted): config 60/min · conversations & leads 10/min ·
  messages 20/min per IP **and** 20/min per visitor token.

---

### `GET /api/v1/widget/config?key=<widgetKey>`

Widget bootstrap. `key` is the public widget key from the embed snippet.

**200**
```json
{
  "data": {
    "receptionistName": "Riley",
    "businessName": "Acme Dental",
    "greeting": "Hi! Welcome — how can I help you today?",
    "language": "en",
    "voiceEnabled": true,
    "branding": {
      "theme": "auto",
      "primaryColor": "#4f46e5",
      "position": "bottom-right",
      "avatarUrl": "",
      "launcherLabel": "Chat with us"
    }
  }
}
```

`404 NOT_FOUND` — unknown key or receptionist deactivated.

---

### `POST /api/v1/widget/conversations`

Starts a conversation and mints the **visitor token** — the browser's only credential, held in
`sessionStorage`, scoped to one conversation.

**Request** `{ "widgetKey": "...", "channel": "chat" | "voice", "pageUrl": "https://..." }`

**201** `{ "data": { "visitorToken": "…48-hex…", "greeting": "Hi! …" } }`

---

### `POST /api/v1/widget/messages`

One conversational turn.

**Request** `{ "visitorToken": "...", "message": "What are your hours?" }` (message ≤ 2000 chars)

**200** `{ "data": { "reply": "We're open Monday to Friday, 9 to 5." } }`

`404` unknown token · `409` conversation ended · `429` rate limited · `502` AI provider down.

---

### `POST /api/v1/widget/leads`

Explicit lead submission (requires email **or** phone). Merges into the conversation's lead.

**Request**
```json
{ "visitorToken": "...", "name": "Jane", "email": "jane@example.com", "phone": "", "intent": "Booking" }
```

**201** `{ "data": { "saved": true } }`

---

### `GET /api/health`

Liveness by default — no outbound calls, always `200` while the process is up:
`{ "data": { "status": "ok", "time": "…" } }`

Add `?deep=1` for a readiness probe that also checks LLM connectivity (`200`
healthy, `503` degraded). The deep probe is rate limited (6/min per IP) to
prevent amplification against the AI provider:
`{ "data": { "status": "ok", "llm": { "provider": "ollama", "healthy": true }, "time": "…" } }`

---

### `GET /api/cron/retention` (internal)

Scheduled data-retention purge. Deletes conversations and usage events older
than each tenant's `data_retention_days`. Requires
`Authorization: Bearer <CRON_SECRET>`; unauthenticated calls get `401`. Wired to
a daily Vercel Cron in `vercel.json`. Returns
`{ "data": { "conversations": <n>, "events": <n> } }`.
