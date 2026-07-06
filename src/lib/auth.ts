import "server-only";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Auth/tenancy helpers for dashboard server components and server actions.
 * All queries run under RLS as the signed-in user.
 */

export async function requireUser(): Promise<User> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return user;
}

export interface BusinessContext {
  userId: string;
  businessId: string;
  role: "owner" | "admin" | "member";
}

/**
 * Resolves the signed-in user's business. Users without one are routed to
 * onboarding. Phase 1 assumes one business per user (the schema already
 * supports many — the picker is a Phase 2 UI concern).
 */
export async function requireBusiness(): Promise<BusinessContext> {
  const user = await requireUser();
  const supabase = await createSupabaseServerClient();

  const { data } = await supabase
    .from("business_members")
    .select("business_id, role")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!data) redirect("/onboarding");

  return {
    userId: user.id,
    businessId: data.business_id,
    role: data.role,
  };
}
