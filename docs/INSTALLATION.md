# Installation Guide

## Prerequisites

- Node.js ≥ 20 (developed on 22)
- A [Supabase](https://supabase.com) project (free tier works)
- [Ollama](https://ollama.com) for local AI (or an API key for a hosted provider)

## 1. Clone and install

```bash
git clone <repo> && cd ai-receptionist
npm install
```

## 2. Set up Supabase

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. Open **SQL Editor** and run every file in
   [`supabase/migrations/`](../supabase/migrations/) **in order** (`0001` through `0009`):
   schema/RLS, then function grants, atomic counters, data retention, retrieval source
   attribution, lead qualification, unanswered-question tracking, the appointment-booking
   tables (staff, scheduling settings, appointments, reminders, calendar connections), and the
   workflow-automation + CRM tables (workflows, events, runs, logs, timers, customers,
   timeline).
   Easiest with the CLI: `supabase db push` with a linked project applies all of them.
   Migration `0008` requires the `btree_gist` extension — the migration creates it itself, but
   confirm your plan allows extensions if you're on a restricted tier.
3. In **Authentication → Providers**, ensure Email is enabled.
   - For frictionless local development, disable "Confirm email".
4. Copy from **Project Settings → API**:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (**secret — server only**)

## 3. Set up the AI provider

**Option A — Ollama (default, free, local):**

```bash
ollama pull llama3.1
# optional, enables semantic knowledge search:
ollama pull nomic-embed-text
```

**Option B — Hosted provider:** set in `.env.local`:

```bash
LLM_PROVIDER=groq            # openai | anthropic | gemini | groq | mistral
LLM_MODEL=llama-3.3-70b-versatile
LLM_API_KEY=sk-...
```

No code changes are needed to switch providers.

## 4. Environment

```bash
cp .env.example .env.local
```

Fill in every value. All variables are documented inline in
[`.env.example`](../.env.example) and validated at startup by
[`src/lib/env.ts`](../src/lib/env.ts) — a missing variable produces a readable
error instead of a runtime failure.

| Variable | Required | Description |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_URL` | yes | Public URL of the app (embed snippet + auth redirects) |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase anon key (RLS applies) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Supabase service key — bypasses RLS, server only |
| `LLM_PROVIDER` | no (`ollama`) | Which LLM adapter to use |
| `LLM_MODEL` | no (`llama3.1`) | Model name for the chosen provider |
| `LLM_API_KEY` | if not ollama | Provider API key |
| `LLM_BASE_URL` | no | Override base URL (self-hosted gateways) |
| `OLLAMA_BASE_URL` | no | Ollama host (default `http://localhost:11434`) |
| `EMBEDDING_PROVIDER` | no (`none`) | `none` = full-text search; `ollama` = vector search |
| `EMBEDDING_MODEL` | no | Embedding model (default `nomic-embed-text`) |
| `LOG_LEVEL` | no (`info`) | `debug` \| `info` \| `warn` \| `error` |
| `CRON_SECRET` | for cron routes | Authorizes `/api/cron/retention`, `/api/cron/reminders`, and `/api/cron/workflows` |
| `MESSAGING_PROVIDER` | no (`log`) | Booking confirmations/reminders; `log` writes to the app log until an SMS/WhatsApp gateway is wired in |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | only if a tenant connects Google Calendar | OAuth app credentials |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | only if a tenant connects Outlook | OAuth app credentials |

Without `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, Dashboard → Settings shows admins a
step-by-step setup wizard (with the exact redirect URI to register in Google Cloud Console)
instead of the Connect button. Workflow automation needs no env var beyond `CRON_SECRET` —
workflows are per-tenant rows (see [WORKFLOWS.md](WORKFLOWS.md)); the per-tenant inbound
webhook trigger stays disabled until `business_settings.workflow_webhook_secret` is set.

Appointment booking itself needs no env var — it's per-tenant data. A business only gets
scheduling once it has a `scheduling_settings` row with `booking_enabled = true` and at least one
active `staff_members` row (there's no dashboard UI for this yet; insert them directly via SQL
Editor until one ships — see [SCHEDULING.md](SCHEDULING.md#known-limits--next-steps)).

## 5. Run

```bash
npm run dev
```

1. Open http://localhost:3000 and **create an account**.
2. Complete onboarding (business name) — a receptionist is created automatically.
3. Fill in your **business profile**, add a few **FAQs** and a **knowledge document**.
4. Open **Install widget → demo page** and talk to your receptionist.

## 6. Verify

```bash
npm test          # unit + integration tests
npm run lint
curl localhost:3000/api/health          # liveness → {"data":{"status":"ok",...}}
curl "localhost:3000/api/health?deep=1" # readiness → includes LLM health when Ollama is up
```
