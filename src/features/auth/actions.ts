"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { logger } from "@halo/platform/logger";
import { safeRedirectPath } from "@halo/platform/safe-redirect";

const credentialsSchema = z.object({
  email: z.string().trim().email("Enter a valid email address").max(254),
  password: z.string().min(8, "Password must be at least 8 characters").max(72),
});

export interface AuthFormState {
  error: string | null;
  message?: string | null;
}

const log = logger.child({ feature: "auth" });

export async function signIn(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signInWithPassword(parsed.data);
    if (error) {
      log.warn("sign in failed", { status: error.status });
      return { error: error.status && error.status < 500 && error.status !== 429
        ? "Invalid email or password" : "Sign-in is temporarily unavailable. Please try again." };
    }
  } catch {
    log.warn("sign in unavailable");
    return { error: "Sign-in is temporarily unavailable. Please try again." };
  }

  redirect(safeRedirectPath(formData.get("next")));
}

export async function signUp(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  let hasSession = false;
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signUp({
      ...parsed.data,
      options: {
        emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
      },
    });

    if (error) {
      log.warn("sign up failed", { status: error.status });
      return { error: "Unable to create an account. Please try again." };
    }
    hasSession = !!data.session;
  } catch {
    log.warn("sign up unavailable");
    return { error: "Unable to create an account. Please try again." };
  }

  // When email confirmation is disabled, a session exists immediately.
  if (hasSession) redirect("/onboarding");

  return {
    error: null,
    message: "Check your inbox — we sent you a confirmation link.",
  };
}

export async function signOut(): Promise<void> {
  let failed = false;
  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signOut();
    failed = !!error;
  } catch {
    failed = true;
  }
  if (failed) log.warn("sign out unavailable");
  redirect(failed ? "/dashboard?error=signout_failed" : "/login");
}
