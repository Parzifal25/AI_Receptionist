import type { CalendarCredentialMigrationMode } from "@halo/platform/calendar-credential-migration";

/** The only database the credential script may reach: the HALO local Supabase REST API. */
export const LOCAL_CALENDAR_CREDENTIAL_TARGET = "http://127.0.0.1:55321";
export const LOCAL_CALENDAR_CREDENTIAL_DATABASE = "postgresql://postgres:postgres@127.0.0.1:55322/postgres";

const TARGET_FLAG = "--target=";
const MODE_FLAGS = ["--decrypt", "--reencrypt", "--verify-current"];
const CALENDAR_CONNECTIONS_PATH = "/rest/v1/calendar_connections";

export type CalendarCredentialRunPlan = {
  /** Proven local origin; the only origin the script's client may contact. */
  origin: string;
  mode: CalendarCredentialMigrationMode;
  verifyOnly: boolean;
};

/** Reject proxy-related environment configuration before a client can exist. */
export function assertNoProxyConfiguration(env: Record<string, string | undefined>): void {
  const configured = Object.keys(env).filter((key) => /(^|_)PROXY$|^NO_PROXY$/i.test(key) && Boolean(env[key]));
  if (configured.length) throw new Error("Proxy environment configuration is prohibited for the local calendar credential operation");
}

/** Validate the CLI's in-memory status JSON without ever logging key values. */
export function assertLocalSupabaseIdentity(
  status: Record<string, unknown>,
  effectiveUrl: string | undefined,
  anonKey: string | undefined,
  serviceRoleKey: string | undefined,
): void {
  if (status.API_URL !== LOCAL_CALENDAR_CREDENTIAL_TARGET || status.DB_URL !== LOCAL_CALENDAR_CREDENTIAL_DATABASE) {
    throw new Error("Supabase CLI status does not identify the expected local HALO instance");
  }
  // The CLI's local keys are the instance fingerprint. Comparing both key
  // values in memory binds configured credentials to this CLI-managed stack.
  if (!status.ANON_KEY || !status.SERVICE_ROLE_KEY || status.ANON_KEY !== anonKey || status.SERVICE_ROLE_KEY !== serviceRoleKey) {
    throw new Error("Configured Supabase keys do not match the local CLI instance");
  }
  requireLocalOrigin(effectiveUrl ?? "", "The effective Supabase URL (NEXT_PUBLIC_SUPABASE_URL)");
}

/**
 * Fail closed unless the value is exactly the local Supabase REST origin.
 * `localhost` and other loopback spellings are rejected: they depend on name
 * resolution or another project's ports, so the target cannot be proven.
 * Messages never echo the value, which may carry embedded credentials.
 */
function requireLocalOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  const bare = !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  if (!bare || url.origin !== LOCAL_CALENDAR_CREDENTIAL_TARGET) {
    throw new Error(`${label} is not the local Supabase target ${LOCAL_CALENDAR_CREDENTIAL_TARGET}; hosted and unproven targets are prohibited`);
  }
  return url.origin;
}

/**
 * Validate the arguments and the target for every mode, read-only included.
 * The operator must name the local target explicitly, and the URL the
 * environment actually resolves to must independently be that same target.
 */
export function planCalendarCredentialRun(
  args: readonly string[],
  effectiveSupabaseUrl: string | undefined,
): CalendarCredentialRunPlan {
  const targets = args.filter((arg) => arg.startsWith(TARGET_FLAG));
  const flags = args.filter((arg) => !arg.startsWith(TARGET_FLAG));
  if (flags.some((arg) => arg !== "--write" && !MODE_FLAGS.includes(arg))) {
    throw new Error("Unknown calendar credential script argument");
  }
  const writeRequested = flags.includes("--write");
  const modes = MODE_FLAGS.filter((arg) => flags.includes(arg));
  if (modes.length > 1) throw new Error("Choose only one of --decrypt, --reencrypt, or --verify-current");
  const verifyOnly = modes[0] === "--verify-current";
  if (verifyOnly && writeRequested) throw new Error("--verify-current is read-only; do not pass --write");
  if (!verifyOnly && !writeRequested) throw new Error("Credential changes require the explicit --write flag");

  if (targets.length === 0) {
    throw new Error(`Missing ${TARGET_FLAG}${LOCAL_CALENDAR_CREDENTIAL_TARGET}; the target is never inferred from the environment`);
  }
  if (targets.length > 1) throw new Error(`Ambiguous target: pass ${TARGET_FLAG} exactly once`);
  const origin = requireLocalOrigin(targets[0].slice(TARGET_FLAG.length), "--target");
  if (!effectiveSupabaseUrl) throw new Error("The effective Supabase URL is not set; the target cannot be proven");
  requireLocalOrigin(effectiveSupabaseUrl, "The effective Supabase URL (NEXT_PUBLIC_SUPABASE_URL)");

  const mode: CalendarCredentialMigrationMode = modes[0] === "--decrypt"
    ? "decrypt"
    : modes[0] === "--reencrypt"
      ? "reencrypt"
      : "encrypt";
  return { origin, mode, verifyOnly };
}

/**
 * Transport-level backstop for the plan: every request must go to the proven
 * origin's calendar_connections table, read-only runs may only read, and
 * redirects are refused so the local server cannot forward the request.
 */
export function createCalendarCredentialFetch(
  plan: Pick<CalendarCredentialRunPlan, "origin" | "verifyOnly">,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  const allowedMethods = plan.verifyOnly ? ["GET"] : ["GET", "PATCH"];
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request ? request.url : String(input));
    if (url.origin !== plan.origin || url.pathname !== CALENDAR_CONNECTIONS_PATH) {
      throw new Error("Blocked calendar credential request outside the proven local target");
    }
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (!allowedMethods.includes(method)) {
      throw new Error(`Blocked ${method} request: not permitted in this calendar credential mode`);
    }
    return baseFetch(input, { ...init, redirect: "error" });
  };
}
