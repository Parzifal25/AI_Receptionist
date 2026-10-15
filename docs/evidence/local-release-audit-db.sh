#!/usr/bin/env bash
# Disposable PostgreSQL + PostgREST for the WS4 audit harnesses.
# Loopback-only ports 55481/55482 (not 5432x, not 5532x); containers removed on exit.
set -uo pipefail
cd "$(dirname "$0")/../.."
RLSLOG="${HALO_GATE_LOG_DIR:-/tmp/halo-local-release-gates}/audit-db-rls.log"; mkdir -p "$(dirname "$RLSLOG")"
SUFFIX=$(openssl rand -hex 4)
PG="halo_check_audit_pg_${SUFFIX}"; REST="halo_check_audit_rest_${SUFFIX}"; DB="halo_check_audit_${SUFFIX}"
PW=$(openssl rand -hex 16); JWT=$(openssl rand -hex 32)
cleanup() { docker rm -f "$REST" "$PG" >/dev/null 2>&1; echo "cleanup: removed $PG $REST"; }
trap cleanup EXIT
for p in 55481 55482; do if ss -ltn | grep -q ":$p "; then echo "port $p busy"; exit 2; fi; done
docker run -d --name "$PG" --pull=never -p 127.0.0.1:55481:5432 -p 127.0.0.1:55482:3000 \
  -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB="$DB" pgvector/pgvector:pg16 >/dev/null || exit 3
URL="postgresql://postgres:${PW}@127.0.0.1:55481/${DB}"
# The image runs a temporary init server first; wait for the final one, twice in a row.
ok=0; for i in $(seq 1 90); do if psql "$URL" -XAtc 'select 1' >/dev/null 2>&1; then ok=$((ok+1)); [ $ok -ge 2 ] && break; else ok=0; fi; sleep 1; done
[ "$(psql "$URL" -XAtc 'select current_database()')" = "$DB" ] || { echo "identity check failed"; exit 4; }
echo "PASS fresh disposable database identity"
export HALO_DISPOSABLE_DATABASE=1 HALO_DISPOSABLE_DB_URL="$URL"
psql "$URL" -X -q -v ON_ERROR_STOP=1 -f infrastructure/ci/supabase-stubs.sql >/dev/null || { echo "stubs failed"; exit 5; }
echo "== check:migrations"; npm run --silent check:migrations > /dev/null 2>&1; MIG=$?; echo "check:migrations exit $MIG"
echo "== check:rls (creates the A/B fixtures the HTTP harness uses)"; npm run --silent check:rls > "$RLSLOG" 2>&1; RLS=$?
echo "check:rls exit $RLS; $(grep -c '^ok' "$RLSLOG") ok; $(grep -cE '^(FAIL|not ok)' "$RLSLOG") FAIL"
echo "== check-security-audit"; node scripts/check-security-audit.mjs; AUD=$?; echo "check-security-audit exit $AUD"
echo "== preflight collector on the full chain"
psql "$URL" -X -f infrastructure/hosted/preflight-readonly.sql | grep -E "objects\||preflight\|complete"
docker run -d --name "$REST" --network "container:$PG" --pull=never \
  -e PGRST_DB_URI="postgresql://postgres:${PW}@127.0.0.1:5432/${DB}" -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$JWT" public.ecr.aws/supabase/postgrest:v14.13 >/dev/null || exit 6
for i in $(seq 1 60); do curl -fs http://127.0.0.1:55482/ >/dev/null 2>&1 && break; sleep 1; done
echo "== check-security-audit-http"
HALO_DISPOSABLE_POSTGREST_URL=http://127.0.0.1:55482 HALO_DISPOSABLE_JWT_SECRET="$JWT" \
  NEXT_PUBLIC_APP_URL=http://localhost:3000 HALO_OUTBOUND_ENABLED=false MESSAGING_PROVIDER=log \
  node --import tsx --conditions react-server scripts/check-security-audit-http.mjs; HTTP=$?
echo "check-security-audit-http exit $HTTP"
echo "SUMMARY migrations=$MIG rls=$RLS audit=$AUD http=$HTTP"
[ $MIG -eq 0 ] && [ $RLS -eq 0 ] && [ $AUD -eq 0 ] && [ $HTTP -eq 0 ]
