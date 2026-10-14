# Operations Runbook

> **Path note (2026-10-15):** `src/lib/rate-limit.ts` is now `packages/platform/rate-limit.ts`. Current architecture and the document map: [HALO_Architecture.md](HALO_Architecture.md).

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
| `/api/cron/no-shows` | every 15 min | Marks overdue appointments as no-shows for tenants that opted in | yes (swept rows go terminal) |

All four require `CRON_SECRET` as a bearer token; Vercel Cron sends it
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

- **Liveness**: `GET /api/health` returns `data.status=ok` without external calls.
  `?deep=1` requires CRON bearer authentication and makes database/provider requests;
  do not configure automatic deep polling without verified cost and authorization.
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

## POA restricted operation and incident procedure — 2026-10-13

The current candidate has no approved external traffic or verified $0 operating
capacity. Follow the [zero-cost release procedure](DEPLOYMENT.md#zero-cost-poa-release-procedure--2026-10-13).
Historical monitoring and provider examples above are not enabled services.

- Keep outbound false, messaging log-only, and voice/calendar/workflow/webhook
  ingress and schedules disabled for the proposed web-chat scope. The outbound
  flag alone does not disable other external actions. Log messaging now omits
  recipient, subject, body, HTML and attachment names; `delivery=simulated` is
  never a provider receipt. Existing reminder/workflow completion in log mode
  still represents simulation, so these automations are excluded from launch.
- On suspected cross-tenant access, data loss, unexpected spend or sustained
  errors, the authorized operator first blocks traffic at hosting ingress and
  stops schedulers, voice workers and integration processing. Merely hiding the
  widget is insufficient. Preserve revision, timestamps, request/event/run IDs
  and sanitized logs; never copy tokens, full prompts or customer message bodies.
- Inspect liveness and available local logs during staffed windows. Deep health
  calls database/provider endpoints and requires separate authorization and cost
  verification. No alert delivery or continuous coverage has been established;
  a named responder, contact channel and support hours are prerequisites.
- Workflow timeouts now abort cooperative executors and immediately park the run
  in `dead_letter` with an unknown-outcome error. No automatic step/cron retry is
  scheduled. A request might already have been accepted remotely; cancellation
  cannot undo it. Reconcile the event/correlation ID with the destination before
  any authorized manual replay. Webhooks receive the cancellation signal and
  reject work cancelled during DNS resolution before sending. Other adapters
  may not support cancellation; late completion cannot mark the run successful.
- Before restore or app rollback, record the incident and preserve the affected
  state according to the approved privacy policy. Restore only from a verified
  recovery point into an identified isolated target, check tenant boundaries,
  reconcile uncertain external effects, and seek owner approval before routing
  traffic back. No deployed backup/restore, RTO or RPO is proven locally.
- Retention cron is a deletion capability, not evidence of policy compliance or
  backup deletion. Approve tenant retention and export/deletion scope (including
  logs, backups and provider copies), verify with synthetic data on the approved
  target, and record evidence. Without a verified recovery/privacy procedure,
  customer-data launch remains blocked.

Safe rollback for this pass: keep all external traffic disabled while reviewing
or reverting only the specific code hunks; do not reset user work. Do not remove
the disposable-target guard to operate on a shared DB. Reverting timeout
quarantine restores duplicate-action risk; keep workflows disabled if reverting.

## Three-gate recovery and incident acceptance

Current status: **hosted operations BLOCKED**. See
[the execution report](HALO_THREE_GATE_EXECUTION.md). No named responder,
verified alert destination, hosted backup inventory or approved RPO/RTO exists
in the evidence. Assign these before any customer traffic; do not equate a
process response with monitored availability or metadata health with inference.

The amended deep-health response exposes DB `checked`/`connected` independently
of other configuration. Query failure must be treated as unavailable operational
data, never a healthy empty queue. Error logs retain route/code/category and
turn/correlation identifiers; raw error messages, credential fields and message
bodies are redacted. Do not add customer text to custom diagnostic fields.
The Auth proxy fails closed on configuration/outage and preserves refresh cookies
and anti-cache headers on redirects. Logout failure explicitly warns that the
session may still be active.

### Incident procedure and hosted acceptance (requires later target authorization)

1. Record exact target, revision/artifact checksum, schema ledger, UTC incident
   start, responder and authorization. For suspected tenant leakage, unexpected
   provider spend, or loss of persistence, the authorized operator blocks traffic
   and pauses schedulers/workers at ingress. Keep outbound disabled, messaging
   log-only, unverified workflows/calendar/webhooks off. Hiding a widget is not
   an ingress block. Do not use provider probes while cost is unknown.
2. Use public liveness and existing sanitized logs. Inspect DB/provider/worker
   status only under target-specific probe authorization and verified $0 limits.
   Check 401/403 Auth failures, 402/429 limits, provider timeouts/5xx, DB write
   failures, and retry/dead-letter growth. Preserve turn/event IDs, never secrets.
3. A staffed manual model requires owner-approved support hours, named primary
   and backup responder, maximum inspection interval, acknowledgement deadline
   and escalation channel. Test it by presenting a synthetic incident to the
   authorized responder and recording detection/acknowledgement/action times.
   No message was sent here and no staffing model or alert delivery is approved.
4. Before restoring, verify source backup ID/checksum, completeness (DB roles,
   Auth identities/session policy, Storage objects and configuration references),
   encryption/access, frequency/retention and an isolated non-production target.
   Approve **numeric RPO and RTO** and exact restore operations. Confirm existing
   free capacity, storage/egress and retention cost; uncertain cost stops work.
5. Restore to the isolated target, never over live data. Apply documented role
   and environment mapping; do not automatically activate restored schedulers,
   webhook destinations or provider credentials. Verify table/row integrity,
   tenant membership, agent/version links, grants/RLS and intended Auth behavior.
6. Run the dashboard login/refresh/logout matrix and widget/persistence/usage
   matrix in the execution report. A real LLM step still requires Gate 1 cost
   evidence. Reconcile uncertain external actions before any replay. Record all
   failed cases; an unverified required dependency prevents gate closure.
7. Measure RPO from the most recent recoverable committed synthetic marker to
   the declared failure time, and RTO from failure declaration to completion of
   all required acceptance checks. Report backup time, restore-only time and
   full service-recovery time separately. Compare with the owner-approved goals.
8. Only after owner acceptance may a separately authorized operator restore
   ingress. If validation fails, keep traffic blocked and preserve the isolated
   target for investigation; never route customers to a partially restored DB.

Local tests exercised provider/DB/Auth failures and readiness/tenant/privacy
assertions. They do not establish responder delivery or hosted availability.
The only measured restore here is the quiescent synthetic local fixture:
**25.807 seconds** from backup start through DB validation, zero fixture-row loss,
44 tables matched, six identity/tenant checks; later 15 application-path checks
also passed. This is not a hosted RPO/RTO promise or real Auth restore.

### Reproduce the disposable restore preparation

First follow the fresh-container migration/RLS/chat-fixture setup in
[integration verification](HALO_REAL_INTEGRATION_VERIFICATION.md). For this
execution, the container is `halo-gates-disposable-20261013`, source DB
`halo_check_integrations`, loopback port 55441. Never reuse a shared instance.
The tool requires that fixture marker and a new target; it refuses overwrite.

```bash
HALO_DISPOSABLE_DATABASE=1 npm run check:recovery:local -- halo-gates-disposable-20261013 halo_check_integrations halo_check_restore_gates
```

Run only while fixture writers are stopped. The backup stays in process memory;
the tool is not a retained-backup service. It shares roles with the source
container; cross-instance role recovery is not covered. On failure it leaves the
new target for inspection and never drops/replaces anything automatically. Pick
a new approved disposable target for a retry.

After restore, a cached PostgREST image can serve that target separately:

```bash
docker run --pull=never --rm -d --name halo-gates-restored-rest-20261013 --network host -e PGRST_DB_URI=postgresql://postgres:postgres@127.0.0.1:55441/halo_check_restore_gates -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET=halo-disposable-synthetic-jwt-secret-20261013 -e PGRST_SERVER_HOST=127.0.0.1 -e PGRST_SERVER_PORT=55444 public.ecr.aws/supabase/postgrest:v14.13
HALO_DISPOSABLE_DATABASE=1 HALO_LOCAL_RESTORED_DATABASE=halo_check_restore_gates npm test -- --config scripts/vitest.local-integration.config.ts
```

Credentials above are fixture-only. Wait for readiness before the test. The
harness blocks external destinations and uses synthetic LLM/Auth; preserve its
JSON result before running another exercise. Stop only containers created for
the exercise after evidence capture. Do not run the destructive canonical RLS
rebuild against the restored dataset as proof of restore integrity.

### Current evidence refresh — 2026-10-13

The current candidate's local build, application suite, worker suite (see the
execution report for its final result), migration validation and disposable RLS
checks do not demonstrate hosted monitoring, alert delivery, backups, recovery,
or rollback. No hosted target or responder was exercised. Keep alert, backup,
RPO/RTO and artifact rollback marked **BLOCKED** until the named operations,
database and release owners provide the isolated authorized $0 target, evidence,
and approval listed in [the three-gate report](HALO_THREE_GATE_EXECUTION.md#current-candidate-refresh--2026-10-13).

The current-candidate local restore was rerun on a fresh, task-owned PostgreSQL
16 container. The synthetic dump restored to a new database; 44 table row
fingerprints matched and six identity/tenant assertions passed. The restored
database then passed the 15-assertion chat integration harness. The measured
17.175 seconds covers only this small local fixture and is not an approved RTO;
RPO/RTO targets remain owner decisions. Verification containers were stopped,
and shared Supabase containers were left untouched. No alert destination was
approved or tested, and no immutable deployment artifact was available for
rollback. See the [current run record](HALO_THREE_GATE_EXECUTION.md#verification-addendum--2026-10-13-full-task-run).

Monitoring completeness is still limited: the tenant-scoped system-status API
reports scheduled/overdue reminders and oldest overdue age, workflow
pending/processing/failed/dead-letter counts, and bounded successful-turn
latency percentiles. It marks status degraded for overdue reminders, failed
runs, and dead-letter runs. Provider failure/timeout rate remains unavailable
because no durable aggregation sink is configured or validated. No hosted alert
destination or delivery drill was available; do not describe alerting as
operational.

### Local alert evaluator follow-up — 2026-10-13

`packages/platform/alerts.ts` provides deterministic threshold evaluation,
incident transition deduplication/resolution, and bounded delivery attempts.
`LocalAlertSink` supports inspection in tests and stores no data outside process
memory. The evaluator is not scheduled or persisted by the application. Local
tests demonstrate alert creation, discovery, duplicate suppression, recovery,
unavailable observations, and observable delivery failure. Hosted alert delivery
and durable incident history remain **BLOCKED** pending a configured destination,
approved test recipient, scheduler, persistence, and a hosted drill.
