"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { safeRedirectPath } from "@/lib/safe-redirect";

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

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    log.warn("sign in failed", { message: error.message });
    return { error: "Invalid email or password" };
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

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    ...parsed.data,
    options: {
      emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
    },
  });

  if (error) {
    log.warn("sign up failed", { message: error.message });
    return { error: error.message };
  }

  // When email confirmation is disabled, a session exists immediately.
  if (data.session) redirect("/onboarding");

  return {
    error: null,
    message: "Check your inbox — we sent you a confirmation link.",
  };
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
