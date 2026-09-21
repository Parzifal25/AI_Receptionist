# Troubleshooting

Symptom-first diagnosis. Each entry: what you see → why → what to do.

## Google Calendar

**Settings shows the "One-time setup required" wizard**
The deployment has no `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`. Follow the
wizard's four steps (OAuth client → register the exact redirect URI it
displays → enable the Calendar API → set env vars, redeploy). Bookings keep
working on the built-in calendar meanwhile.

**`redirect_uri_mismatch` on Google's consent screen**
The URI registered in Google Cloud Console doesn't byte-match
`<NEXT_PUBLIC_APP_URL>/api/oauth/google-calendar/callback`. Check protocol
(https), host, no trailing slash, and that `NEXT_PUBLIC_APP_URL` is the real
production URL.

**Redirected back with "connection attempt expired or didn't match"**
The signed state or CSRF nonce failed: more than 10 minutes on the consent
screen, cookies blocked, or the flow started on a different
browser/deployment than it finished. Try again from Settings in one sitting.

**Connected, but events don't appear on the calendar**
Check logs for `external calendar create failed`. Common causes: the Google
Calendar API not enabled on the OAuth client's project, or the connected
account lacking write access to the `primary` calendar. The appointment row
is still created (external sync is best-effort); reconnecting from Settings
after fixing re-enables sync for new bookings.

## Voice

**No mic button in the widget**
Either the business disabled voice, the browser lacks Web Speech recognition
(Firefox desktop ships without it by default), or the page is served over
plain http (insecure contexts can never use the mic — the widget hides the
button rather than showing one that can't work). `localhost` counts as
secure for development.

**"Microphone access was blocked"**
The visitor denied the permission prompt (or the site is blocked in browser
settings). Voice falls back to chat; after unblocking, tapping the mic
re-runs the permission pre-flight.

**"Speech recognition couldn't reach its service"**
Chrome's recognition is cloud-backed. The visitor is offline, behind a
network that blocks Google's speech endpoints, or in a Chromium build
without the service (some Brave/Electron builds). Retries are automatic
(spaced ~750 ms); the message appears only after the budget is spent. Chat
keeps working.

**Replies appear but aren't spoken (Chrome)**
Chrome occasionally leaves the synthesis queue paused. The widget nudges it
with `speechSynthesis.resume()` on every utterance; if a site embeds an old
cached `widget.js`, a hard refresh picks up the fix.

## Booking

**"Booking is not enabled" / receptionist never offers times**
A tenant books only when `scheduling_settings.booking_enabled = true` AND at
least one active `staff_members` row exists. Both live in the database
(dashboard UI is a known gap).

**`relation "appointments" does not exist`**
Migration `0008` was never applied to this database — see the migration
verification steps in [DEPLOYMENT.md](DEPLOYMENT.md).

**Reminders never send**
In order: `CRON_SECRET` set? cron actually firing (`cron.reminders` in
logs)? `MESSAGING_PROVIDER` still `log` (deliveries only go to the app log
by design)? rows stuck `scheduled` past `send_at` (cron auth failing)?

## Workflows

**Runs stuck in `failed`**
They retry automatically with backoff — stuck means `/api/cron/workflows`
isn't running (same checks as reminders).

**Run in `dead_letter`**
All attempts exhausted. `workflow_run_logs` has per-step, per-attempt
errors. Fix the target (webhook down? bad template producing an empty
`to`?), then re-drive manually: `POST /api/workflows/:id/run`.

**`POST /api/hooks/:businessId` returns 401**
`business_settings.workflow_webhook_secret` is empty (trigger disabled) or
the `x-webhook-token` header/`?token=` doesn't match.

**Duplicate side effects suspected**
By design impossible per event: runs are unique per (workflow, event) and
retries resume from the failed step. If an external system received two
webhooks, it received two *events* (e.g. two real bookings) — check
`workflow_events` by `correlation_id`.

## Chat / LLM

**Every reply is "having trouble connecting right now"**
The LLM provider is failing; the widget never surfaces raw errors. Check
logs for the provider name + code. CPU-hosted Ollama: raise
`LLM_TIMEOUT_MS` (see DEPLOYMENT.md) before switching models.

**REST 404s on tables that exist in psql**
PostgREST schema cache is stale after hand-applied migrations:
`NOTIFY pgrst, 'reload schema';` or restart the PostgREST service.

## Local development (`supabase start` stack)

`.env.local` points `NEXT_PUBLIC_SUPABASE_URL` at `http://127.0.0.1:54321`,
so **the app needs the local Supabase stack running**. `next dev` starts and
serves pages regardless — marketing pages and `/login` render fine without a
database, which is why a stopped stack looks like a working app.

**Sign-up does nothing / "Invalid email or password" on a fresh account**
Check the stack first:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:54321/auth/v1/health  # want 200
npx supabase status
```

`000`/connection refused means the stack is down. If `supabase start` reports
`container is not running: exited`, a container died (WSL/Docker restarts and
host OOM both do this — `docker inspect <name> --format '{{.State.ExitCode}}'`
shows `137`). Recover with:

```bash
npx supabase stop     # backs the database volume up
npx supabase start
```

The first `supabase start` after a while can fail its health check while the
storage service runs its `vector_store` migrations. Re-run it; the second
attempt succeeds.

**Signed up fine, but the dashboard is empty or a page errors**
The local database is probably behind `supabase/migrations/`. Compare:

```bash
npx supabase migration list --local
npx supabase migration up --local     # applies pending, keeps your data
```

If the history is missing a migration whose objects already exist (applied by
hand), mark it applied rather than re-running it:
`npx supabase migration repair --status applied <version> --local`.

**Widget returns 503 "Chat is temporarily unavailable"**
Agent resolution failed closed. A tenant needs an `agents` row
(`slug = receptionist.id`, `status='active'`) with a published
`agent_versions` row. Onboarding provisions this from migration 0021 onward,
and 0022 backfills tenants created before it — so this means migrations are
behind. Check:

```sql
select count(*) from receptionists r
where not exists (select 1 from agents a
                  where a.business_id = r.business_id and a.slug = r.id::text);
```

**`npm run check:rls` wiped my local database**
It used to default to the Supabase CLI database (`:54322`) and it *drops*
`public`/`auth`/`storage` to rebuild them. It now refuses that target. Run it
against a throwaway instead:

```bash
docker run -d --name halo-rls-check -e POSTGRES_PASSWORD=postgres \
  -p 55433:5432 pgvector/pgvector:pg16
PGPASSWORD=postgres psql postgresql://postgres:postgres@127.0.0.1:55433/postgres \
  --set ON_ERROR_STOP=1 -f infrastructure/ci/supabase-stubs.sql
npm run check:rls -- postgresql://postgres:postgres@127.0.0.1:55433/postgres
```

If it already happened, `npx supabase db reset` rebuilds the schema from the
full migration set (local data is lost; `auth.users` too).

**Dev server serves stale routes / new API routes 404**
A long-running `next dev` can drift (new route files not picked up, routes
that worked start returning the not-found page). Restart it. Note that
App Router treats `_`-prefixed folders as private, so `src/app/api/_foo/` is
deliberately not routable.
