"use client";

import { createBrowserClient } from "@supabase/ssr";

/** Browser Supabase client for client components (auth flows, realtime). */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
