# HALO first-hosting migration and database rollout runbook

**Date:** 2026-10-15 · **Status:** PROCEDURE, NOT AUTHORIZATION. Nothing in this runbook has been run against any hosted, staging, shared or developer database. It answers [D21](DECISIONS.md#d21--running-migration-0001-on-hosted-supabase) with evidence, and it sequences the pending migrations `0032` (D7), `0033` (D14) and `0034` (D22).

**Before step 1 may start, all of these must be recorded in [DECISIONS.md](DECISIONS.md):**

- R8 and D19 decided, naming the target project (reference and region), its owner, and the operator.
- D21 approved (the method below or another).
- `0034` adopted (D22). D14 items 1–6 ratified or replaced. Without these approvals the chain stops at `0031`, and the application at this revision must not be deployed against it (§6).
- The owner's written authorization for this exact action on this exact target. G2 requires one.

Evidence labels follow [HALO_Architecture.md §1.3](HALO_Architecture.md#13-evidence-levels).

---

## 1. What is known

| Fact | Evidence |
|---|---|
| Hosted Supabase installs `pgcrypto` in schema `extensions`. `0001` uses `gen_random_bytes` in two column defaults, so it needs `extensions` on the **session** `search_path` while it runs. | `disposable DB`: `public.ecr.aws/supabase/postgres:17.6.1.155`, scenario A below |
| The `postgres` role's own configuration on that image is `search_path="$user", public, extensions`. A plain login as `postgres` therefore applies the unedited chain `0001`–`0034`. | `disposable DB`, scenario P |
| A session that lacks `extensions` fails at `0001_init.sql:151`, `function gen_random_bytes(integer) does not exist`. This is the condition the D10 edit's comment attributes to the CLI's temporary login role. | `disposable DB`, scenario A. That the CLI's `--linked` path uses such a role is **not verified here**: the installed CLI 2.106.0 is a wrapper without its binary, so its behaviour can only be observed on the target (§3). |
| If `vector` is already installed in `extensions`, `0001` fails **even with** `extensions` on the session path. `match_knowledge_chunks` pins `search_path = public` and its body is validated at creation: `operator does not exist: extensions.vector <=> extensions.vector`. | `disposable DB`, scenario C |
| On a fresh project `vector` is available but not installed. `0001` then installs it into `public`, and governed retrieval (`0033`) works as `service_role`. | `disposable DB`, scenario P |
| An additive migration cannot help: it runs only after `0001` has succeeded. | `source`, D10 |
| `0032`–`0034` apply on top of `0001`–`0031` even when legacy tenant mismatches exist. The two `0033` composite keys stay `NOT VALID`, mismatched rows are not served, and both censuses report them. | `disposable DB` (preflight test, below) |
| The local HALO stack's ledger lists `0001`–`0030` (`0001` in its committed form). The hosted ledger is **unknown**: not empty, not zero. | `source` (D10 read-only query); hosted: no query made |
| CI's `check:migrations` runs on vanilla `pgvector:pg16`, where every extension lands in `public`. It does **not** exercise hosted extension placement. | `source` (`scripts/check-migrations.mjs`) |

**Reproduce the image evidence:** `npm run check:supabase-image-chain` (Docker, cached image, `--network none`, no ports; it removes its containers). Result on 2026-10-15: `ok A`, `ok P`, `ok C`; 34 migrations.

---

## 2. Four situations

| Situation | What applies | Path |
|---|---|---|
| **Fresh database** (preflight §4 all false; ledger absent or empty) | The whole chain `0001`–`0034`, once, recorded in the ledger | §4 |
| **Existing database at a known ledger** (for example `0001`–`0030`, like the local stack) | Only the missing versions, in order, after a backup and the censuses | §5 |
| **Linking a hosted project** (`supabase link`) | Nothing. Linking writes local CLI state only (`supabase/.temp`). It is not evidence that any migration ran. | — |
| **Hosted migration history** (`supabase_migrations.schema_migrations`) | Read-only comparison only. Never edit it to "make it match"; `migration repair` is used only for a version that preflight proved applied byte-for-byte. | §3 |

---

## 3. Read-only preflight (every situation)

1. **Connection.** Use the role that will apply migrations: `postgres`, over the direct connection or the session-mode pooler. Do **not** use a transaction-mode pooler. Never print the URL. Keep it in an environment variable from a secret store.
2. **Run** `psql "$TARGET_URL" -X -f infrastructure/hosted/preflight-readonly.sql`. The whole script runs in a `READ ONLY` transaction that is rolled back. It reports:
   - the session's role and `search_path`;
   - extension placement;
   - platform objects (`storage.buckets`, `auth.uid()`, client roles);
   - which HALO migrations' objects exist;
   - the ledger;
   - the knowledge census or its pre-`0033` equivalent;
   - the tenant-reference census or its pre-`0034` equivalent (the same 19 column pairs);
   - client TRUNCATE/REFERENCES/TRIGGER grant counts.

   Tested on 2026-10-15 against a fresh, a `0001`–`0031` and a `0001`–`0034` database (`disposable DB`). It detected a planted cross-tenant calendar connection and a cross-tenant knowledge collection.
3. **Ledger comparison.** Run `supabase migration list --db-url "$TARGET_URL"`, which is read-only. Also compare preflight §5 with `ls supabase/migrations`, by version **and** name.
4. **Dry run.** Run `supabase db push --db-url "$TARGET_URL" --dry-run`. It must list exactly the versions you expect to apply, and nothing else.
5. **Record** all of the above (counts and facts only) in a dated evidence entry before going further.

**Stop. Do not apply anything, and return to the owner, if any of these hold:**

- `search_path_has_extensions` is false on the connection that will run the migrations.
- `stop_vector_outside_public` is true before `0001` (scenario C). Moving the extension or editing `0001` is an owner decision. Do not improvise.
- `storage_buckets`, `auth_uid` or `client_roles` is false: the target is not a Supabase project.
- The ledger and the database objects disagree. For example: objects exist but the ledger is empty; versions are missing in the middle; names differ from the repository; or a version the repository does not have is present.
- The dry run lists anything other than the expected versions.
- Any census row is nonzero and the owner has not dispositioned it in writing. Mismatches are never auto-repaired.
- No verified backup or restore point exists (§5.1) on a database that holds data.

---

## 4. Fresh database

1. Preflight passes, with ledger empty or absent and no HALO objects.
2. Apply with `supabase db push --db-url "$TARGET_URL"` as `postgres`. Do not use `--linked`, whose login role may lack `extensions` (§1). This records every version in the ledger. If the CLI cannot be used, stop: hand-applied files leave no ledger rows, and a later push would try to re-run them.
3. Afterwards:
   - run `migration list` again: every version is applied;
   - re-run the preflight: §8 counts are zero, and both censuses are empty;
   - `NOTIFY pgrst, 'reload schema'` is not needed after `db push`;
   - run the staging verification in [HALO_PHASE_BETA_READINESS.md](HALO_PHASE_BETA_READINESS.md) and the Gate 2 procedure in [HALO_THREE_GATE_EXECUTION.md](HALO_THREE_GATE_EXECUTION.md).

---

## 5. Existing database (upgrade)

### 5.1 Backup and recovery point

- Record the plan's backup type: daily backup or PITR. PITR is a paid add-on, so G2/D8 apply.
- Record the latest restorable point and its time.
- Take a logical dump of the schema and data to owner-approved encrypted storage, never to the repository.
- Restore it onto an isolated, authorized target, and run [OPERATIONS.md](OPERATIONS.md) restore checks **before** migrating. Until that drill passes, RPO and RTO are not claimed (W8.3).

### 5.2 Sequence

Each step is preceded by the preflight and followed by `migration list`.

1. **Catch up `0001`–`0031`**, if the ledger is behind. These are not new decisions; they are the committed baseline.
2. **`0032` (D7, approved).** Additive; it needs no data preparation.
3. **`0033` (D14).** Only after the item 1–6 ratification. From this point, existing knowledge stops being served until it is backfilled, re-indexed and approved. Schedule it with the tenant: run `knowledge_backfill_legacy(business, false)` (dry run) per tenant, review, then apply, re-index and approve through the dashboard.
4. **`0034` (D22).** Only after adoption, and after the pre-`0034` tenant-reference section of the preflight shows zero rows, or every nonzero row is dispositioned.
5. **Deploy the application** built from the same revision (§6).

### 5.3 Rollback limitations

- Prefer a forward correction or a verified restore. Do not reverse migration SQL by hand.
- **`0032`:** dropping `tool_executions` discards the audit record. The current application fails closed for side-effecting tools without the table.
- **`0033`:** dropping it discards approvals and revision history. Members lost direct knowledge writes. An older application build still retrieves safely, because the old RPC names return governed content only, but it cannot edit knowledge.
- **`0034`:** dropping its triggers re-opens the cross-tenant references. Re-granting the revoked privileges would re-open TRUNCATE.

---

## 6. Application and schema compatibility

| Application at this revision against… | Effect |
|---|---|
| A schema without `0032` | `save_contact_details` and `offer_concession` return `AUDIT_UNAVAILABLE`: fail closed. Handoff still works. |
| A schema without `0033` | The governed RPCs do not exist. Knowledge retrieval degrades to no knowledge (a safe but broken answer path), and dashboard knowledge editing fails. |
| A schema without `0034` | It works, but the database does not refuse cross-tenant references, and clients keep TRUNCATE. |

**Rule:** migrate first, then deploy the matching application. Never leave this application running against an older schema.

---

## 7. Evidence still needed before a real rollout

| Gate | How it is closed | State |
|---|---|---|
| The target's identity, owner, region and authorization | R8, D19, written authorization | OWNER APPROVAL REQUIRED |
| The CLI path's session `search_path` on the target | Preflight §1 on the exact connection | NOT VERIFIED |
| `vector` placement on the target | Preflight §2 | NOT VERIFIED |
| The hosted ledger, and whether `0001` was ever attempted (D10: linked 2026-10-13 17:39; the edit made at 18:34) | Preflight §5 and `migration list` | NOT VERIFIED |
| Backup plan, restore point, restore drill, RPO and RTO | §5.1, W8.3 | NOT VERIFIED; RPO/RTO OWNER APPROVAL REQUIRED |
| Census results and owner disposition | Preflight §6–§7 | NOT VERIFIED |
| Post-migration real-role isolation and Auth | Gate 2, W1.5 | NOT VERIFIED |
