import "server-only";
import { getServerEnv } from "@halo/platform/env";
import { getAdminClient } from "@halo/tenancy/supabase/admin";

export interface ReadinessReport {
  ready: boolean;
  errors: string[];
  warnings: string[];
  database: { connected: boolean; checked: boolean };
  providers: {
    email: boolean;
    whatsapp: boolean;
  };
}

/** A database that accepts the connection but never answers must read as down, not hang the probe. */
const DATABASE_PROBE_TIMEOUT_MS = 5_000;

export async function validateProductionReadiness(options: {
  /**
   * Downgrade the database connectivity probe to a warning (CI has no
   * database). Never silently skipped — the warning records it.
   */
  skipDatabaseCheck?: boolean;
} = {}): Promise<ReadinessReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const database = { connected: false, checked: false };
  
  let env;
  try {
    env = getServerEnv();
  } catch {
    return {
      ready: false,
      errors: ["Environment validation failed"],
      warnings: [],
      database,
      providers: { email: false, whatsapp: false },
    };
  }

  const providers = {
    email: (env.MESSAGING_PROVIDER ?? "log").includes("resend"),
    whatsapp: (env.MESSAGING_PROVIDER ?? "log").includes("whatsapp"),
  };

  if (providers.email && (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL)) {
    errors.push("RESEND_API_KEY and RESEND_FROM_EMAIL must be set when messaging provider includes resend");
  }
  
  if (providers.whatsapp && (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_ACCESS_TOKEN)) {
    errors.push("WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN must be set when messaging provider includes whatsapp");
  }

  if (env.NODE_ENV === "production") {
    if (!env.CRON_SECRET) {
      errors.push("CRON_SECRET is required in production");
    } else if (env.CRON_SECRET.length < 32) {
      errors.push("CRON_SECRET must be at least 32 characters in production");
    }
  } else {
    if (!env.CRON_SECRET || env.CRON_SECRET.length < 32) {
      warnings.push("CRON_SECRET is missing or less than 32 characters (recommended for production)");
    }
  }

  if (!options.skipDatabaseCheck) {
    database.checked = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const adminClient = getAdminClient();
      const { error } = await Promise.race([
        adminClient.from("businesses").select("id").limit(1),
        new Promise<{ error: true }>((resolve) => {
          timer = setTimeout(() => resolve({ error: true }), DATABASE_PROBE_TIMEOUT_MS);
        }),
      ]);
      if (error) {
        errors.push("Database connectivity check failed");
      } else {
        database.connected = true;
      }
    } catch {
      errors.push("Database connectivity check failed");
    } finally {
      clearTimeout(timer);
    }
  } else {
    warnings.push("Database connectivity check skipped (--skip-db-check)");
  }

  return {
    ready: errors.length === 0,
    errors,
    warnings,
    database,
    providers,
  };
}
