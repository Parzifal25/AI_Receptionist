import "server-only";
import { getServerEnv } from "@halo/platform/env";
import { getAdminClient } from "@halo/tenancy/supabase/admin";

export interface ReadinessReport {
  ready: boolean;
  errors: string[];
  warnings: string[];
  providers: {
    email: boolean;
    whatsapp: boolean;
  };
}

export async function validateProductionReadiness(options: {
  /**
   * Downgrade the database connectivity probe to a warning (CI has no
   * database). Never silently skipped — the warning records it.
   */
  skipDatabaseCheck?: boolean;
} = {}): Promise<ReadinessReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  let env;
  try {
    env = getServerEnv();
  } catch (err) {
    return {
      ready: false,
      errors: [`Environment validation failed: ${err instanceof Error ? err.message : String(err)}`],
      warnings: [],
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
    try {
      const adminClient = getAdminClient();
      const { error } = await adminClient.from("businesses").select("id").limit(1);
      if (error) {
        errors.push(`Database connectivity check failed: ${error.message}`);
      }
    } catch (err) {
      errors.push(`Database connectivity check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    warnings.push("Database connectivity check skipped (--skip-db-check)");
  }

  return {
    ready: errors.length === 0,
    errors,
    warnings,
    providers,
  };
}
