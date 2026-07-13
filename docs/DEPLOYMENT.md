# Deployment Guide

The app is a standard Next.js App Router project — it deploys anywhere Next.js runs. The
reference deployment is **Vercel + Supabase**.

## 1. Supabase (production project)

1. Create a dedicated production project (never share the dev project).
2. Run every file in `supabase/migrations/` in order, `0001` through `0008` (or `supabase db push`).
   `0008_appointments.sql` adds the appointment-booking schema, including a GiST exclusion
   constraint that prevents double-booking — requires the `btree_gist` extension, which the
   migration enables itself.
   - **Verify before assuming this is done.** `supabase migration list` compares local
     migration files against `supabase_migrations.schema_migrations` in the target database —
     a mismatch there (fewer rows than files) means some migrations were never applied, even if
     earlier ones succeeded. Symptom in the app: `scheduling_settings`/`appointments`/
     `staff_members` lookups fail (relation does not exist) while everything from `0001`-`0006`
     works fine. Apply the missing files directly with `psql -f supabase/migrations/000N_*.sql`
     if `supabase db push` can't reach the project (e.g. local Postgres refusing the CLI's TLS
     negotiation — connect with a plain `psql` URL instead).
   - **PostgREST schema cache**: after applying migrations by hand (not through `supabase
     db push`/the dashboard, which do this for you), PostgREST needs to be told new
     tables/columns exist: run `NOTIFY pgrst, 'reload schema';` against the database, or
     restart the `postgrest`/`supabase_rest_*` service. Until that happens, REST calls against
     the new tables 404 even though the tables are visible in `psql`.
3. Authentication:
   - Enable email confirmation.
   - Set **Site URL** to your production domain and add
     `https://yourdomain.com/auth/callback` to the redirect allow list.

## 2. AI provider

Ollama is a development default. In production use a hosted provider:

```
LLM_PROVIDER=groq                # or openai / anthropic / gemini / mistral
LLM_MODEL=llama-3.3-70b-versatile
LLM_API_KEY=...
```

(Ollama also works in production if you run it on infrastructure reachable from your deployment
via `OLLAMA_BASE_URL` — a GPU box behind a private network.)

**Timeouts on CPU-hosted Ollama.** `LLM_TIMEOUT_MS` (default `60000`) bounds every
`complete()` call across all providers. A CPU-only Ollama host is the case most likely to
need it raised: prompt-eval + generation time scales with system-prompt size (the receptionist
prompt runs ~5-6k characters once business profile, tone, and retrieved knowledge are
included) and available CPU, not just model parameter count — a 1B-parameter model on a
constrained VM measured ~60-65s for one turn in testing, i.e. right at the default. Symptoms of
this being too low: `"ollama request timed out"` in logs and visitors seeing the canned
"having trouble connecting" fallback reply on every message. Fix by raising
`LLM_TIMEOUT_MS` (120000 is a reasonable floor for CPU-only Ollama) before concluding the
provider itself is broken; hosted providers rarely need more than the default. The
`elapsedMs`/`promptChars` fields logged on every Ollama error/slow-response make it possible to
tell timeout-config from prompt-size from genuine unreachability at a glance.

A provider failure (timeout, unreachable, non-2xx, empty response) never fails the chat
request — `ChatService` catches it and returns a fixed fallback reply so the widget always
gets a `200` with a usable message, never a raw `502`. The failure is still logged at `error`
with the provider name and error code for alerting; only the visitor-facing behavior degrades
gracefully.

## 3. Vercel

```bash
vercel link
vercel env add   # add every variable from .env.example, for Production
vercel --prod
```

Notes:

- `npm run build` bundles `public/widget.js` before `next build` — no extra step.
- The widget is served from your app origin: customers embed
  `https://yourdomain.com/widget.js`. Vercel's CDN caches static `public/` assets
  automatically.
- The in-memory rate limiter is per-instance. Under Fluid Compute this is acceptable at launch;
  swap in a Redis-backed `RateLimiter` (Upstash via Vercel Marketplace) when you scale out —
  the interface in `src/lib/rate-limit.ts` is already async for exactly this.
- **Data retention**: `vercel.json` registers a daily cron hitting
  `/api/cron/retention`, which deletes conversations and analytics events past
  each tenant's `data_retention_days`. Set `CRON_SECRET` (`openssl rand -hex 32`)
  in production — the route rejects any call without it, and Vercel Cron sends it
  automatically. On non-Vercel hosts, schedule the same authenticated GET yourself.
- **Appointment reminders**: `vercel.json` also registers a 5-minute cron hitting
  `/api/cron/reminders`, which delivers due SMS/email reminders (same `CRON_SECRET`).
  Set `MESSAGING_PROVIDER` to a real gateway once you have one (default `log` writes to
  the application log, so reminders "work" in the sense of being tracked, but nothing is
  actually sent to visitors until a real provider is wired in). See
  [SCHEDULING.md](SCHEDULING.md).
- **Calendar connections**: if any tenant will connect Google Calendar or Outlook, set
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and/or `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`
  (OAuth app credentials from each platform's developer console) before they try to connect.

## 4. Post-deploy verification

1. `curl https://yourdomain.com/api/health` → `{"status":"ok"}` (liveness).
   Use `/api/health?deep=1` to also verify LLM connectivity.
2. Register → onboard → configure receptionist → add an FAQ.
3. Open the install page, load the demo, exchange a message and a voice turn.
4. Confirm the conversation and (if you shared contact info) the lead in the dashboard.
5. Add your website's domain in settings and confirm an unlisted origin is rejected.

## Production checklist

- [ ] Dedicated Supabase production project; migration applied; email confirmation on
- [ ] All env vars set in the hosting platform (no `.env` files in the image)
- [ ] `SUPABASE_SERVICE_ROLE_KEY` present **only** as a server-side secret
- [ ] Hosted LLM provider configured with billing alerts
- [ ] `NEXT_PUBLIC_APP_URL` = production URL (drives embed snippets + auth emails)
- [ ] `/api/health` wired to uptime monitoring (use `?deep=1` for LLM readiness alerts)
- [ ] Log drain configured (structured JSON logs are aggregator-ready)
- [ ] Error tracking (Sentry or similar) added to `error.tsx` handlers
- [ ] Custom domain + HTTPS
- [ ] Backup policy confirmed on Supabase (PITR on paid tiers)
- [ ] Rate limiter upgraded to Redis if running multiple instances
- [ ] `CRON_SECRET` set so the daily data-retention purge and 5-min reminder delivery run and are authenticated
- [ ] `MESSAGING_PROVIDER` set to a real gateway if appointment reminders/confirmations must reach visitors (default `log` does not send anything)
- [ ] Migration `0008` applied and the `appointments_no_overlap` exclusion constraint verified present, if scheduling is in use
- [ ] `supabase migration list` (or `psql`'s `supabase_migrations.schema_migrations`) shows every file in `supabase/migrations/` as applied — not just the ones a partial `db push` happened to reach
- [ ] If migrations were applied by hand rather than via `supabase db push`/dashboard, `NOTIFY pgrst, 'reload schema'` was sent (or PostgREST restarted) so the new tables are queryable
- [ ] `LLM_TIMEOUT_MS` sized for the provider actually in use (raise well above the 60s default for CPU-hosted Ollama)
