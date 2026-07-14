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
