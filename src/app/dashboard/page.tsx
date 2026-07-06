import type { Metadata } from "next";
import Link from "next/link";
import { requireBusiness } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, CardBody, CardHeader } from "@/components/ui/card";

export const metadata: Metadata = { title: "Overview — AI Receptionist" };

async function countRows(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  table: string,
  businessId: string,
  extra?: { column: string; gte: string },
) {
  let query = supabase
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq("business_id", businessId);
  if (extra) query = query.gte(extra.column, extra.gte);
  const { count } = await query;
  return count ?? 0;
}

function sevenDaysAgoIso(): string {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

export default async function OverviewPage() {
  const { businessId } = await requireBusiness();
  const supabase = await createSupabaseServerClient();

  const since = sevenDaysAgoIso();
  const [conversations, leads, conversationsWeek, leadsWeek, faqs, documents] =
    await Promise.all([
      countRows(supabase, "conversations", businessId),
      countRows(supabase, "leads", businessId),
      countRows(supabase, "conversations", businessId, { column: "started_at", gte: since }),
      countRows(supabase, "leads", businessId, { column: "created_at", gte: since }),
      countRows(supabase, "faqs", businessId),
      countRows(supabase, "knowledge_documents", businessId),
    ]);

  const stats = [
    { label: "Conversations (7 days)", value: conversationsWeek, total: `${conversations} all time` },
    { label: "Leads (7 days)", value: leadsWeek, total: `${leads} all time` },
    { label: "FAQs", value: faqs, total: "published & drafts" },
    { label: "Knowledge documents", value: documents, total: "in your knowledge base" },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Overview</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          How your AI receptionist is doing.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardBody>
              <p className="text-sm font-medium text-slate-500 dark:text-slate-400">{stat.label}</p>
              <p className="mt-1 text-3xl font-bold text-slate-900 dark:text-white">{stat.value}</p>
              <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{stat.total}</p>
            </CardBody>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader
          title="Analytics"
          description="Deeper analytics — conversation trends, answer quality, busiest hours — arrive in Phase 2."
        />
        <CardBody>
          <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-slate-300 text-sm text-slate-400 dark:border-slate-700 dark:text-slate-500">
            Charts coming soon
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Get set up" description="Three steps to a live receptionist." />
        <CardBody>
          <ol className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
            <li>
              1.{" "}
              <Link href="/dashboard/profile" className="font-medium text-indigo-600 hover:text-indigo-500">
                Complete your business profile
              </Link>{" "}
              — the receptionist introduces your business from it.
            </li>
            <li>
              2.{" "}
              <Link href="/dashboard/faqs" className="font-medium text-indigo-600 hover:text-indigo-500">
                Add FAQs
              </Link>{" "}
              and{" "}
              <Link href="/dashboard/knowledge" className="font-medium text-indigo-600 hover:text-indigo-500">
                knowledge documents
              </Link>{" "}
              — this is what it answers from.
            </li>
            <li>
              3.{" "}
              <Link href="/dashboard/install" className="font-medium text-indigo-600 hover:text-indigo-500">
                Install the widget
              </Link>{" "}
              — one script tag on your website.
            </li>
          </ol>
        </CardBody>
      </Card>
    </div>
  );
}
