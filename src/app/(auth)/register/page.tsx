import type { Metadata } from "next";
import { signUp } from "@/features/auth/actions";
import { AuthForm } from "@/features/auth/auth-form";

export const metadata: Metadata = { title: "Create account — AI Receptionist" };

export default function RegisterPage() {
  return (
    <>
      <h1 className="mb-6 text-center text-xl font-semibold text-slate-900 dark:text-white">
        Create your account
      </h1>
      <AuthForm mode="register" action={signUp} />
    </>
  );
}
