# Operations Runbook

Day-2 operations: the scheduled jobs, the queues, what to monitor, and what
to do when something is stuck. Deployment itself is
[DEPLOYMENT.md](DEPLOYMENT.md); diagnosis flows are
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Scheduled jobs (Vercel Cron, `vercel.json`)

| Route | Schedule | Does | Safe to overlap? |
|---|---|---|---|
| `/api/cron/retention` | daily 03:00 | Purges conversations/analytics past each tenant's retention window | yes |
| `/api/cron/reminders` | every 5 min | Delivers due appointment reminders | yes (SKIP LOCKED) |
| `/api/cron/workflows` | every 5 min | Fires due workflow timers, retries failed runs | yes (SKIP LOCKED) |

All three require `CRON_SECRET` as a bearer token; Vercel Cron sends it
automatically. On other hosts, schedule authenticated GETs yourself. A
misconfigured secret returns 500/401 and logs at `error` — alert on it.

## Queues and their stuck states

- **Reminders** (`appointment_reminders`): rows in `scheduled` past
  `send_at` mean the cron isn't running (check `CRON_SECRET`, cron logs).
  `failed` with `attempts >= 3` are given up — inspect `last_error`.
- **Workflow runs** (`workflow_runs`): `failed` rows retry automatically;
  `dead_letter` rows do not. Inspect `error` and `workflow_run_logs`
  (per-step detail), fix the cause, then re-drive with
  `POST /api/workflows/:id/run` if needed.
- **Timers** (`workflow_timers`): unfired rows past `fire_at` = cron issue,
  same diagnosis as reminders.

## Monitoring

- **Liveness**: `GET /api/health` → `{"status":"ok"}`; `?deep=1` adds LLM
  connectivity. Wire both into uptime monitoring.
- **Logs**: everything is single-line JSON — point a log drain at the
  deployment. High-signal fields: `level`, `service`/`route`, `code`,
  `correlationId`, `runId`. Alert on `level=error` from
  `service=workflow-engine` (dead letters), `route=cron.*` (job auth or
  processing failures), and `provider` codes from LLM calls.
- **Analytics events** (`usage_events`): booking funnel
  (`appointment_booked/rescheduled/cancelled`), `lead_captured`,
  `customer_created`, `workflow_custom` — cheap health signals per tenant.

## Routine tasks

- **Rotating the webhook trigger secret**: update
  `business_settings.workflow_webhook_secret` for the tenant, then update
  the external systems that call `/api/hooks/:businessId`.
- **Rotating `CRON_SECRET`**: set the new env var and redeploy; Vercel Cron
  picks it up automatically.
- **Google OAuth credential rotation**: replace
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, redeploy; existing tenant
  refresh tokens keep working (they belong to the same OAuth client — a
  *new* client requires every tenant to reconnect from Settings).
- **Applying migrations by hand**: after `psql -f`, run
  `NOTIFY pgrst, 'reload schema';` so PostgREST sees new tables.

## Capacity notes

- The in-memory rate limiter is per-instance; move to Redis when scaling
  beyond one instance (`src/lib/rate-limit.ts` is already async).
- Workflow/reminder crons process batches of 25 per tick; a burst simply
  drains over successive ticks. Raise batch sizes only with DB headroom.
- CPU-hosted Ollama: size `LLM_TIMEOUT_MS` per DEPLOYMENT.md before
  concluding the provider is down.
