"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormError, FormSuccess } from "@/components/ui/form-feedback";
import type { AuthFormState } from "./actions";

const INITIAL: AuthFormState = { error: null };

export function AuthForm({
  mode,
  action,
  next,
}: {
  mode: "login" | "register";
  action: (prev: AuthFormState, formData: FormData) => Promise<AuthFormState>;
  next?: string;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      {next && <input type="hidden" name="next" value={next} />}
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          minLength={8}
          required
        />
      </div>

      <FormError message={state.error} />
      <FormSuccess message={state.message} />

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
      </Button>

      <p className="text-center text-sm text-slate-500 dark:text-slate-400">
        {mode === "login" ? (
          <>
            New here?{" "}
            <Link href="/register" className="font-medium text-indigo-600 hover:text-indigo-500">
              Create an account
            </Link>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-indigo-600 hover:text-indigo-500">
              Sign in
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
