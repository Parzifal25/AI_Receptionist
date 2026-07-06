import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/lib/env";

let cached: SupabaseClient | null = null;

/**
 * Service-role client. BYPASSES RLS — use only inside server code that
 * applies its own tenant scoping (the widget API, background indexing).
 * Never import from a client component; `server-only` enforces that at
 * build time.
 */
export function getAdminClient(): SupabaseClient {
  if (cached) return cached;
  const env = getServerEnv();
  cached = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}
