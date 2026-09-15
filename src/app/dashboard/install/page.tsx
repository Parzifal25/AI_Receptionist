import type { Metadata } from "next";
import Link from "next/link";
import { requireBusiness } from "@halo/tenancy/auth";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { getServerEnv } from "@halo/platform/env";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CopySnippet } from "@/features/install/copy-snippet";

export const metadata: Metadata = { title: "Install widget — AI Receptionist" };

export default async function InstallPage() {
  const { businessId } = await requireBusiness();
  const supabase = await createSupabaseServerClient();
  const env = getServerEnv();

  const { data: receptionist } = await supabase
    .from("receptionists")
    .select("widget_key, is_active")
    .eq("business_id", businessId)
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  const appUrl = env.NEXT_PUBLIC_APP_URL;
  const snippet = `<script src="${appUrl}/widget.js" data-key="${receptionist!.widget_key}" async></script>`;

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Install the widget</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          One script tag, anywhere before the closing <code>&lt;/body&gt;</code> tag of your website.
        </p>
      </div>

      {!receptionist!.is_active && (
        <p className="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          Your receptionist is currently inactive — the widget won&apos;t load until you activate it in{" "}
          <Link href="/dashboard/receptionist" className="font-medium underline">
            receptionist settings
          </Link>
          .
        </p>
      )}

      <Card>
        <CardHeader title="Embed code" />
        <CardBody>
          <CopySnippet snippet={snippet} />
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
            The <code className="rounded bg-slate-100 px-1 py-0.5 text-xs dark:bg-slate-800">data-key</code>{" "}
            identifies your receptionist. It is public and safe to expose — it grants no access to your
            data, only the ability to start conversations.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Try it" description="A demo page with your widget already installed." />
        <CardBody>
          <Link
            href={`/widget-demo?key=${receptionist!.widget_key}`}
            target="_blank"
            className="text-sm font-medium text-indigo-600 hover:text-indigo-500"
          >
            Open demo page →
          </Link>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Lock it down" />
        <CardBody className="text-sm text-slate-600 dark:text-slate-300">
          Once installed, add your website&apos;s domain in{" "}
          <Link href="/dashboard/settings" className="font-medium text-indigo-600 hover:text-indigo-500">
            settings
          </Link>{" "}
          so only your site can embed this widget.
        </CardBody>
      </Card>
    </div>
  );
}
