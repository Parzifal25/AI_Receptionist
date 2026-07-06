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
2. Open **SQL Editor** and run the entire contents of
   [`supabase/migrations/0001_init.sql`](../supabase/migrations/0001_init.sql).
   (Or use the CLI: `supabase db push` with a linked project.)
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
npm test          # 41 unit + integration tests
npm run lint
curl localhost:3000/api/health   # {"data":{"status":"ok",...}} when Ollama is up
```
