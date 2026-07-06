import type { Metadata } from "next";
import { requireBusiness } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SettingsForm } from "@/features/settings/settings-form";

export const metadata: Metadata = { title: "Settings — AI Receptionist" };

export default async function SettingsPage() {
  const { businessId, role } = await requireBusiness();
  const supabase = await createSupabaseServerClient();

  const { data: settings } = await supabase
    .from("business_settings")
    .select("allowed_domains, notify_on_lead, notification_email")
    .eq("business_id", businessId)
    .single();

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Settings</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Security and notification preferences for your workspace.
        </p>
      </div>
      <SettingsForm
        readOnly={role === "member"}
        settings={{
          allowedDomains: settings?.allowed_domains ?? [],
          notifyOnLead: settings?.notify_on_lead ?? true,
          notificationEmail: settings?.notification_email ?? "",
        }}
      />
    </div>
  );
}
