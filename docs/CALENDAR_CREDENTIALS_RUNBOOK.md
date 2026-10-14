# Calendar credential encryption runbook

This runbook covers the `calendar_connections` credential fields: `access_token`,
`refresh_token`, `basic_username`, and `basic_password`. The table remains
service-role-only under RLS. Values use the existing `text` columns and the
application format `v1.<nonce>.<tag>.<ciphertext>` (base64url components),
encrypted with AES-256-GCM.

## Key handling

- Generate 32 random bytes with a trusted cryptographic generator, for example
  `openssl rand -hex 32`. Store the result as
  `CALENDAR_CREDENTIALS_ENCRYPTION_KEY` in the deployment secret manager.
- Do not put the key in source control, a `NEXT_PUBLIC_` variable, logs, shell
  command arguments, or an ordinary database table. Restrict access to the
  application and designated operators.
- Retain the key securely for as long as any database backup containing its
  ciphertext may need restoration. Loss of the applicable key makes those
  credentials unrecoverable; a database backup alone is insufficient.
- The application accepts a temporary
  `CALENDAR_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` during rotation. Never remove
  the old key until a full active-key verification has passed.

## Target guard (local only)

`scripts/calendar-credentials.ts` refuses every target except the HALO local
Supabase REST API. Every mode, including the read-only `--verify-current`,
requires both of the following and fails closed before any request otherwise:

- `--target=http://127.0.0.1:55321` passed exactly once. The target is never
  inferred from an environment file.
- An effective `NEXT_PUBLIC_SUPABASE_URL` in the process environment that is
  that same origin. If the environment resolves to hosted Supabase, the
  script stops even when `--target` names the local instance.

`localhost`, other ports, HTTPS, and URLs with a path, query, or embedded
credentials are rejected as unprovable. The script's client is bound to the
proven origin and the `calendar_connections` table; `--verify-current` can only
issue reads. The steps below therefore cannot be run against hosted Supabase
with this script as it stands; a hosted migration needs a separate, reviewed
change to the guard.

## Initial rollout and backfill

The standalone Node command does not load `.env.local`. Supply the reviewed
local environment through the operator's secret injection mechanism. Do not
source or print environment files. A configured hosted URL must cause refusal;
do not bypass that refusal by replacing only the URL while retaining other keys.
The script compares both configured keys and both local endpoints with CLI
status in memory before constructing its client. Proxy configuration is refused.
The CLI child process disables telemetry and captures status privately, with a
120-second timeout; never run raw status JSON into a terminal or log.

1. Take and verify a recoverable database backup. Ensure the key is escrowed
   separately from that backup.
2. Configure the active key in the server secret manager before deploying the
   credential-aware application. Google Calendar connect is disabled unless
   OAuth credentials and the encryption key are configured.
3. Deploy the dual-read application. It reads legacy plaintext for the staged
   rollout and writes new/rotated credentials as ciphertext. Keep the key
   stable for the full migration. Drain all older application instances before
   starting the scan; any legacy writer left running could insert plaintext
   after its keyset cursor has passed that row.
4. Run the script through the normal operator environment, with Supabase
   credentials and the encryption key injected by the secret manager:

   ```sh
   node --import tsx --conditions react-server scripts/calendar-credentials.ts --target=http://127.0.0.1:55321 --write
   ```

   It scans in ordered batches of 250. It compares the row id and all four
   source fields before each update, so a concurrent refresh cannot be
   overwritten by the scanned snapshot. A conflict stops the pass; rerun the
   same command to resume. Already encrypted rows and empty fields are skipped.
5. Verify that every nonempty field is ciphertext authenticated by the active
   key:

   ```sh
   node --import tsx --conditions react-server scripts/calendar-credentials.ts --target=http://127.0.0.1:55321 --verify-current
   ```

   This command is read-only and fails on plaintext, malformed ciphertext, or
   an authentication/key mismatch. For a database-side count without reading
   credential values, use a query like:

   ```sql
   select count(*) as rows_with_plaintext_credentials
   from public.calendar_connections
   where (access_token <> '' and access_token not like 'v1.%')
      or (refresh_token <> '' and refresh_token not like 'v1.%')
      or (basic_username <> '' and basic_username not like 'v1.%')
      or (basic_password <> '' and basic_password not like 'v1.%');
   ```

   The count must be zero. Do not select or export credential contents for
   verification.

The backfill command is a database write. Review the target and credential
source before an operator runs it. Do not run it against a hosted database
without the separately required operational authorization.

## Key rotation

1. Back up the database and retain both keys securely.
2. Set the new key as `CALENDAR_CREDENTIALS_ENCRYPTION_KEY` and the old key as
   `CALENDAR_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS`. New application writes now
   use the new key; reads can authenticate with either key.
3. Run:

   ```sh
   node --import tsx --conditions react-server scripts/calendar-credentials.ts --target=http://127.0.0.1:55321 --reencrypt --write
   ```

   This re-encrypts all encrypted credential fields with the active key. The
   operation is resumable: if interrupted, rerun it while both keys remain
   configured. Compare-and-swap prevents stale rows from replacing concurrent
   updates.
4. Remove the previous key from the runtime environment, then run
   `--verify-current`. Removing the previous key before verification passes
   makes any missed old-key ciphertext fail closed and easier to identify.
5. Retain the old key in controlled escrow for the required backup retention
   period; it may be needed to restore an older backup.

The envelope version identifies the encryption format, not the key identity.
`--reencrypt` therefore deliberately processes every encrypted value and may
be rerun safely, but it does not report progress by key version.

## Rollback

The pre-encryption application cannot read ciphertext. To roll back to it:

1. Stop calendar credential writers (OAuth connects and token-refresh workers)
   and drain in-flight requests. This avoids new ciphertext being written
   during the conversion.
2. Keep the applicable active and previous keys configured. Run:

   ```sh
   node --import tsx --conditions react-server scripts/calendar-credentials.ts --target=http://127.0.0.1:55321 --decrypt --write
   ```

   The script decrypts each prefixed value and leaves plaintext values alone;
   compare-and-swap conflicts stop the pass for a safe rerun.
3. Check the count query below. During rollback, a nonzero plaintext count is
   expected when credentials exist. Also confirm no ciphertext remains before
   restoring service to an application version that cannot decrypt it:

   ```sql
   select count(*) as rows_with_encrypted_credentials
   from public.calendar_connections
   where access_token like 'v1.%' or refresh_token like 'v1.%'
      or basic_username like 'v1.%' or basic_password like 'v1.%';
   ```

   The encrypted-field count must be zero. Restore service only after the rows
   are in the format expected by the target application version.
4. Retain the keys until no encrypted backups or replicas need them.

Rollback writes plaintext credentials back to the database. Treat it as a
controlled recovery operation, keep the service-role/RLS boundary intact, and
re-encrypt after recovery if the encrypted application remains the target.

## Recovery and limitations

- A failed scan or compare-and-swap update stops the script; fix the underlying
  database/key issue and rerun. The scan is keyset-paginated by UUID, so it does
  not depend on the REST API's default row cap.
- Keep the current and previous keys available to all application instances
  throughout rotation; mixed key configuration can cause intermittent
  credential failures.
- Plaintext legacy reads exist only for staged migration compatibility. Remove
  that fallback in a later release after every database and restored backup
  has been migrated.
- Encryption protects against database-only disclosure. It does not protect
  against a compromised application process, service-role credentials, or an
  operator who can read both the database and key.

## Local read-only preflight — 2026-10-14

Disposition: **STOP before credential mutation.** CLI visibility is restored,
but the effective configured API URL, anon key and service-role key do not match
the running local stack, and the active encryption key is absent. The CLI DB URL
matches the expected local target. No environment files were edited.

- CLI version: `2.106.0`. Help confirms `status --output json` and `--workdir`.
  The initial sandbox failure was `EROFS` while writing CLI telemetry; Docker
  access was also denied in the sandbox. Process-only telemetry suppression and
  approved local Docker access produced valid status JSON, exit 0. No restart,
  reset, upgrade, migration or hosted operation was needed.
- Local DB, Kong, Auth and Storage containers are healthy; REST is running.
  Realtime, Studio, Inbucket, pooler, analytics and edge runtime are disabled in
  local configuration and are not required for this REST table scan.
- A local `BEGIN READ ONLY` aggregate returned **1 total row, 1 row requiring
  encryption, 0 rows containing ciphertext**. No credential values were selected.
- Backup: `/home/parzifal/halo-backups/calendar-credentials/local-postgres-prechange-20261013T175128Z.dump`,
  820995 bytes, mode `0600`. SHA-256 matches the existing sidecar; custom archive
  magic and container `pg_restore --list` pass, including calendar table schema
  and data entries. No restore was attempted. These checks establish archive
  integrity and inventory, not a successful restore or current snapshot equality.
- Actual configured `--verify-current`: exit 1, rejected the unproven effective
  target before CLI lookup, client construction or HTTP requests. Successful
  active-key verification remains pending correct local secret injection and
  the separately approved encryption. The existing plaintext row would fail it.
- Six targeted test files pass, **55 tests passed, 0 failed**. Entry tests cover
  target/proxy/missing-key/CLI/JSON/identity refusal before client construction
  and HTTP requests, plus private CLI capture. Transport tests reject forbidden
  requests before the underlying fetch. Typecheck and `git diff --check` pass.

After separately resolving secret injection and approving the write, the exact
proposed command from the repository root is:

```sh
node --import tsx --conditions react-server scripts/calendar-credentials.ts --target=http://127.0.0.1:55321 --write
```

Expected current effect: one row updated, only its nonempty legacy credential
fields encrypted; existing ciphertext and empty fields skipped. Recount and
revalidate the backup before approval because writers may change this snapshot.
Drain credential writers before the pass. Keep the active key securely escrowed.
On interruption or compare-and-swap conflict, retain the same key, investigate,
and rerun only under the separate write authorization. Recovery may use the
documented `--decrypt --write` rollback or a controlled backup restore; either
requires separate mutation authorization. Do not restore over concurrent changes.
Retain the key for any encrypted backups.

Exact post-write command in the same verified local operator environment:

```sh
node --import tsx --conditions react-server scripts/calendar-credentials.ts --target=http://127.0.0.1:55321 --verify-current
```

Expected result at the current row count: one row authenticated with the active
key, exit 0, and zero rows in the plaintext count query above. Neither the write
nor recovery command was executed during this preflight.
