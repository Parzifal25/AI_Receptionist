# HALO Phase 3 — Baseline

Recorded **2026-09-21**, before any Phase 3 hardening change in this working session.
Purpose: separate pre-existing conditions from Phase 3 regressions.

## Git state

- Branch: `main`, working tree **clean** (`git status --porcelain` empty).
- HEAD: `658dac5 V1`.
- Preceding voice commits already on `main`:
  - `df5f7b9 feat(voice): provider-neutral voice contracts, call state machine, voice session`
  - `67ff61b feat(runtime,voice): phone channel profile, turn cancellation, phone channel adapter`
  - `502e41b feat(voice): calls data model, call persistence, voice gateway`
  - `45ab83e feat(voice): reference telephony adapter, gateway service, latency harness`
  - `a57fbb6 feat(language): Telugu/Tenglish language packs and deterministic parsers`

This is important: **Phase 3 was substantially implemented in prior sessions.** The
checklist in `docs/PHASE3_PHASE4_EXECUTION_PLAN.md` still reads `TODO` for P3-01..P3-12,
which is *stale documentation*, not missing code. Work in this session is therefore
verification and hardening, not greenfield construction.

## Gate results at baseline

| Gate | Command | Result |
| --- | --- | --- |
| Tests | `npm run test` | **PASS** — 84 files, 774 tests, 0 failures (13.6s) |
| Typecheck | `npm run typecheck` | **PASS** — clean |
| Lint | `npm run lint` | **PASS** — clean |
| Architecture | `npm run check:architecture` | **PASS** — runtime+voice boundaries, provider direction, closed tool registry, RLS on every table |
| Neutrality | `npm run check:neutral` | **PASS** — `packages/` industry-neutral and boundary-clean |
| Migrations | `npm run check:migrations` | **PASS** — all 20 migrations apply; asserted columns exist |
| RLS | `npm run check:rls` | **PASS** — tenant isolation holds as real `authenticated` / `service_role` roles |

### Database gate environment note

`check:migrations` and `check:rls` initially failed with `connection refused` on
`127.0.0.1:54322` — **an environment gap, not a code defect.** The Docker daemon runs but
has no registry network access (`auth.docker.io` unreachable), so images cannot be pulled.
Resolved using a pre-existing local image:

```
docker run -d --name halo-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=postgres -p 54322:5432 pgvector/pgvector:pg16
psql "$SUPABASE_DB_URL" --set ON_ERROR_STOP=1 -f infrastructure/ci/supabase-stubs.sql
npm run check:migrations
node scripts/check-rls.mjs postgresql://postgres:postgres@127.0.0.1:54322/rlscheck
```

The stub step is required because the migrations assume Supabase's `auth`/`storage`
schemas; CI does the same (`.github/workflows/ci.yml`, migrations job). `check:rls` must
run against a **fresh** database, hence the separate `rlscheck` database.

## Known pre-existing failures

**None.** Every gate passes at baseline. Any failure appearing later in this session is a
regression introduced by this session's changes and must be treated as such.

## Phase 2 invariants that must remain unchanged

These are load-bearing and were verified green at baseline; Phase 3 work must not weaken them:

1. **Agent Runtime stays channel-independent.** Voice adapts to the runtime; the runtime
   gains no voice-specific branches. Enforced by `check:architecture`.
2. **`packages/` stays industry-neutral** — no tenant- or vertical-specific logic.
   Enforced by `check:neutral`.
3. **Closed tool registry.** The model selects from a fixed registry; it cannot name
   arbitrary tools or execute arbitrary code.
4. **Act-then-narrate.** The model proposes, the application validates and executes, the
   model narrates only verified results.
5. **Tenant isolation via RLS on every table**, verified as the real database roles, never
   as the RLS-bypassing owner.
6. **Agent version attribution** — every conversation/call is attributable to the exact
   `agent_version_id` that served it; published versions are immutable (trigger-enforced).
7. **All 774 pre-existing tests keep passing.**
