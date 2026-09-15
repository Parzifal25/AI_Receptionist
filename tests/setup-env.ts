/**
 * Test-environment bootstrap (runs once before any test module loads).
 *
 * Server modules validate configuration on first access (getServerEnv) and
 * several construct Supabase clients in their default parameters. Tests must
 * be hermetic — they pass on a machine with no .env.local and in CI — so the
 * required variables get placeholder values here unless the environment
 * already provided real ones.
 *
 * This does NOT change production behaviour: getServerEnv still fails fast on
 * a genuinely unconfigured deployment. env.test.ts deletes these variables
 * explicitly to exercise that failure path, and every test that varies
 * optional env (providers, secrets) sets its own values via resetEnvCacheForTests.
 */
const REQUIRED_PLACEHOLDERS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
};

for (const [key, value] of Object.entries(REQUIRED_PLACEHOLDERS)) {
  if (!process.env[key]) process.env[key] = value;
}
