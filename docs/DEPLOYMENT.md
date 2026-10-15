# Deployment Guide

> **Release gate:** these instructions are not authorization to deploy or migrate. For Phase Beta, first identify and obtain approval for a dedicated staging project and follow [HALO Phase Beta readiness](HALO_PHASE_BETA_READINESS.md). Never point migration/recovery checks at production, a shared developer database, or an unidentified target. The repository currently has 34 ordered migration files; verify the exact candidate's migration ledger rather than relying on the historical `0001`–`0009` list below. **For any hosted Supabase target, follow [HOSTED_MIGRATION_RUNBOOK.md](HOSTED_MIGRATION_RUNBOOK.md)** (D21): its read-only preflight, stop rules and `db push --db-url` path supersede the by-hand advice in §1 below.

The app is a standard Next.js App Router project — it deploys anywhere Next.js runs. The
reference deployment is **Vercel + Supabase**.

## 1. Supabase (dedicated environment project)

1. Create a dedicated production project (never share the dev project).
2. For an approved environment, use the repository's supported migration procedure and apply every migration present in `supabase/migrations/` in order on that dedicated target. Do not assume an old numbered range is complete; record the candidate revision and compare the target migration ledger before and after. Do not use `scripts/check-migrations.mjs` or `scripts/check-rls.mjs` against an existing/shared target: they are local validation harnesses intended for disposable databases, and the RLS script drops schemas.
   `0008_appointments.sql` adds the appointment-booking schema, including a GiST exclusion
   constraint that prevents double-booking — requires the `btree_gist` extension, which the
   migration enables itself. `0009_workflows.sql` adds the workflow automation platform
   (workflows, events, runs, logs, timers) and the built-in CRM (customers, timeline).
   - **Verify before assuming this is done.** `supabase migration list` compares local
     migration files against `supabase_migrations.schema_migrations` in the target database —
     a mismatch there (fewer rows than files) means some migrations were never applied, even if
     earlier ones succeeded. Symptom in the app: `scheduling_settings`/`appointments`/
     `staff_members` lookups fail (relation does not exist) while everything from `0001`-`0006`
     works fine. **Hosted targets:** do not apply missing files with `psql -f`. Hand-applied files
     leave no rows in `supabase_migrations.schema_migrations`, so a later `db push` tries to
     re-run them. Stop and follow [HOSTED_MIGRATION_RUNBOOK.md](HOSTED_MIGRATION_RUNBOOK.md)
     (corrected 2026-10-15). For a disposable local database only, `psql -f` remains acceptable.
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
- The in-memory rate limiter is per-instance and does not establish a safe multi-instance
  launch or aggregate spending cap. Approve topology and limits before launch; a distributed
  limiter requires separate design and verified zero-cost capacity.
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
- **Workflow automation**: `vercel.json` registers a third 5-minute cron hitting
  `/api/cron/workflows`, which fires due workflow timers (scheduled follow-ups) and retries
  failed workflow runs (same `CRON_SECRET`). Inbound webhook triggers
  (`POST /api/hooks/:businessId`) stay disabled per tenant until
  `business_settings.workflow_webhook_secret` is set. See [WORKFLOWS.md](WORKFLOWS.md).
- **Automatic no-shows**: `vercel.json` registers a 15-minute cron hitting
  `/api/cron/no-shows` (same `CRON_SECRET`). It only touches businesses that turned the
  sweep on in Settings → Customer lifecycle, and only appointments nobody checked in whose
  end time plus the grace period has passed. Every sweep emits `appointment.no_show`, so a
  recovery journey reaches the customer without staff input. See
  [LIFECYCLE.md](LIFECYCLE.md#during-the-appointment).
- **Calendar connections**: if any tenant will connect Google Calendar or Outlook, set
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and/or `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`
  (OAuth app credentials from each platform's developer console) before they try to connect.
  For Google, register `<NEXT_PUBLIC_APP_URL>/api/oauth/google-calendar/callback` as an
  authorized redirect URI and enable the Google Calendar API on the project; tenants then
  connect from Dashboard → Settings → "Connect Google Calendar". Until the credentials are
  set, that Settings card shows admins a step-by-step setup wizard (including the exact
  redirect URI to register) instead of a connect button.

## 4. Post-deploy verification

1. `curl https://yourdomain.com/api/health` → `{"status":"ok"}` (liveness).
   `/api/health?deep=1` requires the CRON bearer secret and makes DB/provider requests;
   use it only after target, cost and probe authorization are verified.
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
- [ ] `CRON_SECRET` set so the data-retention purge, reminder delivery, workflow processing, and no-show sweep crons run and are authenticated
- [ ] `MESSAGING_PROVIDER` set to a real gateway if appointment reminders/confirmations must reach visitors (default `log` does not send anything)
- [ ] Migration `0008` applied and the `appointments_no_overlap` exclusion constraint verified present, if scheduling is in use
- [ ] `supabase migration list` (or `psql`'s `supabase_migrations.schema_migrations`) shows every file in `supabase/migrations/` as applied — not just the ones a partial `db push` happened to reach
- [ ] If migrations were applied by hand rather than via `supabase db push`/dashboard, `NOTIFY pgrst, 'reload schema'` was sent (or PostgREST restarted) so the new tables are queryable
- [ ] `LLM_TIMEOUT_MS` sized for the provider actually in use (raise well above the 60s default for CPU-hosted Ollama)

## Zero-cost POA release procedure — 2026-10-13

This section governs the current restricted candidate; older platform setup examples
above do not authorize provisioning, billing, provider calls, or deployment.
There is **no approved launch target or capacity**. The current permitted external
launch envelope is **zero tenants / zero requests** until the owner verifies cost,
authentication, data handling, recovery and the staging gates. A proposed next
scope is allowlisted web chat on one application instance; its tenant, concurrency,
request and retention limits require account evidence and owner approval. Existing
per-IP/token in-memory limits are not distributed quotas or spending caps.

### Candidate and feature record

Before a separately authorized release, record the responsible owner, UTC window,
project/region/endpoint identity, exact approved commit and artifact checksum,
migration ledger, feature/configuration review, and recovery/disable owner. A dirty
working tree is not a deployable approved revision. Keep `HALO_OUTBOUND_ENABLED=false`
and `MESSAGING_PROVIDER=log`. Log mode records simulation metadata, not delivery.
Exclude voice, live calendar operations, outbound campaigns, workflows, webhooks,
real messaging, OAuth connection changes and customer automation from the proposed
chat scope. Disable their scheduler entries and public ingress at the approved host;
do not assume the outbound-call flag disables calendars or workflow webhooks.
Provision a fresh allowlisted tenant with no tool grants or enabled workflows.
Do not connect external accounts. Chat itself requires an approved LLM and database;
no zero-cost route has been verified. Do not use Ollama for this POA.

### External dependency inventory

| Dependency | Repository capability | Cost/availability and current disposition |
|---|---|---|
| Application hosting, TLS/domain, network and cron | Next.js; Vercel reference config | Account, quotas, suspension and incremental cost unverified; no deployment authorized |
| Supabase Postgres/Auth/storage | Tenant data, authentication, service-role access | Hosted capacity, retention, auth mail, backup/restore and cost unverified; local disposable DB only |
| LLM (Groq/OpenRouter/OpenAI/Anthropic/Gemini/Mistral), optional embeddings | Provider adapters, context/token bounds | Every hosted route and quota unverified; no real calls authorized; no currency cap |
| Sarvam STT/TTS and voice gateway/Pipecat hosting | Primary speech route and mocked lifecycle | Real provider cost/quality/availability unverified; voice excluded; Telugu human review pending |
| Twilio | Telephony and outbound calls | Cost, numbers and consent unverified; outbound false; voice ingress excluded |
| Google/Outlook/CalDAV | OAuth, availability and event writes | Accounts, costs, policies and real receipts unverified; exclude all connections/writes |
| Resend/WhatsApp and generic webhooks/CRM | Delivery adapters and workflows | Destination, consent, price and quotas unverified; log-only messaging; workflows excluded |
| Logs, monitoring, alert destination, backups and recovery storage | JSON logs, health routes, runbooks | No verified free alert delivery or hosted restore; manual support coverage/RTO/RPO unknown |
| GitHub Actions/package registries | CI workflow and dependencies | Hosted CI quota/cost unverified; no remote CI triggered; existing local dependencies used |
| Local Node/Python/Docker/pgvector | Installed tools, cached image, synthetic fixtures | No purchases, downloads, inference or paid service calls in this pass; local checks only |

For each selected dependency the owner must attach dated account evidence for
incremental cost, quota, overage behavior, billing/trial state, suspension, data
retention and recovery. Unknown is a release blocker, not a free-tier assumption.

### Disposable validation only

Both check scripts now require explicit disposable acknowledgement, a numeric
loopback host, an explicit port other than the local Supabase CLI ports, and a
`halo_check_` database name. They ignore `SUPABASE_DB_URL`, reject URI query
parameters, and must never be used as hosted migration tools. These guards reduce
accidental targeting; a loopback tunnel or falsely named shared database is still
unsafe. The operator must identify a newly created dedicated container first.

Example using an already cached image (choose an unused container name/port):

```bash
docker run --pull=never -d --name halo-poa-disposable-20261013 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=halo_check_poa \
  -p 127.0.0.1:55440:5432 pgvector/pgvector:pg16
docker exec -i halo-poa-disposable-20261013 psql -U postgres -d halo_check_poa \
  --set ON_ERROR_STOP=1 < infrastructure/ci/supabase-stubs.sql
HALO_DISPOSABLE_DATABASE=1 npm run check:migrations -- postgresql://postgres:postgres@127.0.0.1:55440/halo_check_poa
HALO_DISPOSABLE_DATABASE=1 npm run check:rls -- postgresql://postgres:postgres@127.0.0.1:55440/halo_check_poa
```

The example credential is synthetic and applies only to this disposable container.
RLS deliberately rebuilds its schemas. Migration validation replays selected
backfills; it does not prove every historical migration can be blindly reapplied.
No existing migration was rewritten in this pass.

### Required release, verification and recovery gates

1. Obtain named owner, verified isolated target, exact revision/artifact, explicit
   action authorization, confirmed $0 incremental cost, scope/window and recovery
   procedure. This implementation pass supplies none of those external approvals.
2. Review secret presence/format through the approved secret manager without
   logging values. Review Supabase URL/keys, app URL/Auth callback allowlist,
   CRON secret, selected LLM/model/timeout, allowed origins and disabled features.
   Configuration preflight with a skipped DB is not deployed readiness.
3. Before any hosted migration, record the target ledger/schema and an approved
   recovery point; prove a restore on an isolated authorized target. Apply only
   pending migration files with the approved migration mechanism/operator; verify
   ledger, identity constraints and RLS with intended roles. Never guess identities
   for unmatched historical conversations. Stop on mismatch or partial failure.
4. Verify exact deployed artifact, public liveness, authenticated readiness,
   allowlisted tenant A/B access, widget identity, rejected origins, missing/wrong
   cron auth, disabled integrations and honest failure responses. Deep health
   performs DB/provider requests: it needs its own cost/authorization check and
   must not be polled under this zero-cost pass. Liveness alone proves process
   response only. Use synthetic fixtures and no real customer data.
5. Rehearse safe disable and restoration; record measured recovery and data loss
   bounds. App rollback requires schema compatibility. Do not reverse migrations
   blindly; use an approved forward fix or verified restore. Do not claim RTO/RPO
   from this local migration exercise.
6. Preserve dated test results, artifact and migration hashes, reviewed config
   names, receipts where authorized, and signed go/no-go. Any missing mandatory
   gate means no-go, including for web chat.

## Three-gate release and rollback acceptance

**This execution does not authorize deployment.** See
[three-gate findings and evidence](HALO_THREE_GATE_EXECUTION.md). Real inference,
intended-project Auth and hosted monitoring/recovery/rollback remain BLOCKED.
Existing platform commands earlier in this document are reference instructions,
not approval to create resources, enable cron, buy backups or deploy this tree.
Billing alerts do not enforce the mission's $0 ceiling. Metadata health does not
prove inference or available quota; never set up unattended deep polling first.

For a later release, the release owner must supply an approved **immutable current
artifact and previous artifact** with commit, build ID, checksum, dependency lock
hash and configuration schema/version. Record dirty-worktree status explicitly;
this uncommitted candidate is not an approved rollback artifact. Keep the artifact
and its compatible migration ledger together. Health/API response alone cannot
identify a deployed revision: compare the hosting deployment record to the
approved artifact before and after the exercise.

### Rollback decision and verification procedure (not executed)

1. Identify application host and isolated staging/restore target; obtain exact
   artifact-selection/traffic-switch authorization, verified $0 execution and
   storage/egress capacity, incident owner and recovery point. No automated
   deployment/rollback command is authorized by this runbook alone.
2. Compare the currently applied migration ledger and schema to the previous
   artifact's required tables, columns, constraints, policies and data formats.
   Test both application versions against that schema in isolation. Additive
   schema is not automatically compatible: changed identity/authorization and
   write semantics must be checked. Never infer compatibility just from a lower
   commit number or a successful process startup.
3. If compatible, the authorized operator selects the approved prior application
   artifact while keeping traffic/side effects disabled. Record deployment/build
   ID and checksum. If incompatible, **do not switch the app**: prefer an approved
   forward fix; otherwise use a verified isolated restore plus compatible app.
   Do not reverse migration SQL or guess legacy tenant/agent identities.
4. Verify public liveness, authorized readiness (DB checked and connected), correct
   artifact, authenticated dashboard refresh/logout, protected API/RLS tenant A/B
   denial, widget identity/persistence, and real LLM behavior only if its $0 gate
   is cleared. Check queue state and duplicate-action quarantine; keep outbound,
   live messaging/calendar/webhooks and unsupported voice off.
5. Record rollback duration, each acceptance result, data reconciliation and
   rollback-to-current escape path. Failure keeps traffic blocked. No hosted
   gate passes while Auth, LLM, restore integrity or responder evidence is missing.
6. Restore ingress only with the explicit owner go/no-go. Preserve both artifact
   records and the migration ledger; no commit, push or deploy was done here.

Local code rollback for this mission needs no migration. Review only the new
Auth, redirect, logging and monitoring hunks and added test/tool files; do not
reset/stash/clean or overwrite earlier user work. Reverting fixes would reopen
tenant-count leakage, redirect/cookie and diagnostic defects: keep all traffic
disabled until replacement fixes are verified. The local dump/restore exercise
in Operations proves neither application artifact rollback nor hosted recovery.

### Current candidate release boundary — 2026-10-13

Candidate `cb6b75496755364cd288adb62b3492830b841288` has fresh passing local
build and regression evidence, but no verified deployment target, approved
artifact checksum, hosted Auth test, $0 inference route, alert delivery, restore,
or compatible artifact rollback. The current release recommendation is **NO-GO**;
deployment remains unauthorized. Preserve disabled external traffic and use the
minimum owner inputs in [the three-gate report](HALO_THREE_GATE_EXECUTION.md#current-candidate-refresh--2026-10-13)
before any separately authorized hosted procedure.

The local alert evaluator and in-memory sink added on 2026-10-13 are testable
building blocks, not deployment wiring: no scheduler, durable store, approved
notification destination, or production delivery has been configured. Local alert
tests pass; hosted delivery remains blocked. No compatible prior immutable app
artifact is available, so artifact rollback remains blocked. Use a forward-fix
when schema changes are not backward compatible; do not reverse an irreversible
migration as part of an application rollback.

Fresh local verification on the same candidate passed the full JS suite,
lint/type/architecture/neutral checks, production build, configuration preflight,
Python worker suite, disposable migration/RLS checks, synthetic chat journey and
local restore/post-restore journey. It does not supply a deployment artifact
digest or prove hosted Auth, provider billing/quota, alert delivery, backup
retention or application rollback. Keep deployment **NO-GO** until the external
owner actions in the [three-gate report](HALO_THREE_GATE_EXECUTION.md#verification-addendum--2026-10-13-full-task-run)
are complete and separately authorized.
