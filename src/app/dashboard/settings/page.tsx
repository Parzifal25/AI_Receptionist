import type { Metadata } from "next";
import { requireBusiness } from "@/lib/auth";
import { getServerEnv } from "@/lib/env";
import { googleRedirectUri } from "@/app/api/oauth/google-calendar/shared";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { SettingsForm } from "@/features/settings/settings-form";
import { CalendarConnectionCard } from "@/features/settings/calendar-connection-card";

export const metadata: Metadata = { title: "Settings — AI Receptionist" };

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ calendar?: string; calendar_error?: string }>;
}) {
  const { businessId, role } = await requireBusiness();
  const env = getServerEnv();
  const supabase = await createSupabaseServerClient();
  const params = await searchParams;

  const { data: settings } = await supabase
    .from("business_settings")
    .select("allowed_domains, notify_on_lead, notification_email")
    .eq("business_id", businessId)
    .single();

  // calendar_connections holds OAuth tokens and is service-role-only; read
  // just the non-secret status fields, scoped to this business.
  const { data: calendar } = await getAdminClient()
    .from("calendar_connections")
    .select("created_at")
    .eq("business_id", businessId)
    .eq("provider", "google")
    .is("staff_id", null)
    .maybeSingle();

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Settings</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Security and notification preferences for your workspace.
        </p>
      </div>
      <CalendarConnectionCard
        connected={calendar !== null}
        connectedAt={calendar?.created_at ?? null}
        readOnly={role === "member"}
        configured={Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)}
        redirectUri={googleRedirectUri(env)}
        flowResult={
          params.calendar === "connected"
            ? { connected: true }
            : params.calendar_error
              ? { connected: false, error: params.calendar_error }
              : undefined
        }
      />
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
