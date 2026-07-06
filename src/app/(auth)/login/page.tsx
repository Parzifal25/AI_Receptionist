import type { Metadata } from "next";
import { signIn } from "@/features/auth/actions";
import { AuthForm } from "@/features/auth/auth-form";

export const metadata: Metadata = { title: "Sign in — AI Receptionist" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  return (
    <>
      <h1 className="mb-6 text-center text-xl font-semibold text-slate-900 dark:text-white">
        Welcome back
      </h1>
      {params.error === "auth_callback_failed" && (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          Sign-in link expired or invalid. Please try again.
        </p>
      )}
      <AuthForm mode="login" action={signIn} next={params.next} />
    </>
  );
}
