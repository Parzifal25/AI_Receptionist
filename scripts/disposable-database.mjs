/** Fail before invoking psql. No developer DB fallback and no URL in errors. */
export function requireDisposableDatabase(argument, env) {
  const reject = () => {
    throw new Error("Database checks require HALO_DISPOSABLE_DATABASE=1 and an explicit loopback PostgreSQL URL naming halo_check_<suffix>. Use a fresh disposable instance; shared and hosted targets are prohibited.");
  };
  if (env.HALO_DISPOSABLE_DATABASE !== "1") reject();
  const raw = argument ?? env.HALO_DISPOSABLE_DB_URL;
  let url;
  try { url = new URL(raw); } catch { reject(); }
  // Query parameters can override libpq host/database selection. Reject all.
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || !url.port || ['54322', '55322'].includes(url.port)
      || !/^\/halo_check_[a-z0-9_]+$/.test(url.pathname)
      || url.search || url.hash) reject();
  return raw;
}

/**
 * The disposable PostgREST in front of such a database. Loopback http only,
 * never a Supabase CLI API port, and a locally generated JWT secret. No
 * developer fallback and no URL or secret in errors.
 */
export function requireDisposablePostgrest(env) {
  const reject = () => {
    throw new Error("PostgREST checks require HALO_DISPOSABLE_POSTGREST_URL (loopback http, not a Supabase CLI port) and HALO_DISPOSABLE_JWT_SECRET (32+ characters) for a disposable instance.");
  };
  if (env.HALO_DISPOSABLE_DATABASE !== "1") reject();
  let url;
  try { url = new URL(env.HALO_DISPOSABLE_POSTGREST_URL); } catch { reject(); }
  if (url.protocol !== "http:"
      || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || !url.port || ["54321", "55321"].includes(url.port)
      || url.pathname !== "/" || url.search || url.hash) reject();
  const secret = env.HALO_DISPOSABLE_JWT_SECRET;
  if (typeof secret !== "string" || secret.length < 32) reject();
  return { url: url.origin, jwtSecret: secret };
}
