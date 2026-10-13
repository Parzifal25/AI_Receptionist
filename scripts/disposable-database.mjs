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
