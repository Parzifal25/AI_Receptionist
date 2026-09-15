import type { Metadata } from "next";
import Link from "next/link";
import { requireBusiness } from "@halo/tenancy/auth";
import { getServerEnv } from "@halo/platform/env";
import { googleRedirectUri } from "@/app/api/oauth/google-calendar/shared";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
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
      <Card>
        <CardHeader
          title="Customer lifecycle"
          description="Directions, prep instructions, intake form, reminder schedule, review link, and automatic no-shows."
        />
        <CardBody>
          <Link
            href="/dashboard/settings/lifecycle"
            className="text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
          >
            Configure lifecycle content →
          </Link>
        </CardBody>
      </Card>
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
