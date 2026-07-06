import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { OnboardingForm } from "@/features/business/onboarding-form";

export const metadata: Metadata = { title: "Set up your business — AI Receptionist" };
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const user = await requireUser();
  const supabase = await createSupabaseServerClient();

  const { data: membership } = await supabase
    .from("business_members")
    .select("business_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (membership) redirect("/dashboard");

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 dark:bg-slate-950">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-white">
          Set up your business
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          We&apos;ll create your AI receptionist and dashboard. You can change everything later.
        </p>
        <div className="mt-6">
          <OnboardingForm />
        </div>
      </div>
    </div>
  );
}
