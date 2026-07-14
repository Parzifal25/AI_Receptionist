import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireBusiness } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, CardBody, CardHeader, EmptyState } from "@/components/ui/card";

export const metadata: Metadata = { title: "Customer — AI Receptionist" };

/** Timeline kinds a member can filter on; mirrors what writers record. */
const KINDS = ["appointment", "lead", "reminder", "review", "email", "whatsapp", "revenue", "alert"] as const;

const KIND_ICONS: Record<string, string> = {
  appointment: "📅",
  lead: "✨",
  reminder: "⏰",
  review: "⭐",
  email: "✉️",
  whatsapp: "💬",
  revenue: "💰",
  alert: "🚩",
  merge: "🔗",
};

function likePattern(q: string): string {
  return `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; kind?: string }>;
}) {
  const { businessId } = await requireBusiness();
  const { id } = await params;
  const { q, kind } = await searchParams;
  const search = (q ?? "").trim().slice(0, 100);
  const kindFilter = KINDS.includes(kind as (typeof KINDS)[number]) ? kind : "";

  const supabase = await createSupabaseServerClient();
  const { data: customer } = await supabase
    .from("customers")
    .select("id, name, email, phone, stage, source, total_appointments, revenue_total, first_seen_at")
    .eq("business_id", businessId)
    .eq("id", id)
    .maybeSingle();
  if (!customer) notFound();

  let timelineQuery = supabase
    .from("customer_timeline")
    .select("id, kind, title, detail, occurred_at")
    .eq("business_id", businessId)
    .eq("customer_id", id)
    .order("occurred_at", { ascending: false })
    .limit(200);
  if (kindFilter) timelineQuery = timelineQuery.eq("kind", kindFilter);
  if (search) timelineQuery = timelineQuery.ilike("title", likePattern(search));
  const { data: timeline } = await timelineQuery;

  const displayName = customer.name || customer.email || customer.phone || "Unknown";
  const baseHref = `/dashboard/customers/${id}`;
  const withParams = (nextKind: string) => {
    const parts = new URLSearchParams();
    if (search) parts.set("q", search);
    if (nextKind) parts.set("kind", nextKind);
    const qs = parts.toString();
    return qs ? `${baseHref}?${qs}` : baseHref;
  };

  return (
    <div className="max-w-4xl space-y-8">
      <div>
        <Link
          href="/dashboard/customers"
          className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          ← All customers
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">{displayName}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {[customer.email, customer.phone].filter(Boolean).join(" · ") || "No contact info"} ·{" "}
          {customer.stage} · {customer.total_appointments} appointment
          {customer.total_appointments === 1 ? "" : "s"}
          {Number(customer.revenue_total) > 0 &&
            ` · ${Number(customer.revenue_total).toFixed(2)} revenue`}
        </p>
      </div>

      <Card>
        <CardHeader
          title="Timeline"
          description="Every interaction — appointments, conversations, reminders, reviews, and more."
        />
        <CardBody className="space-y-4">
          <form className="flex max-w-md gap-2" action={baseHref} method="get">
            {kindFilter && <input type="hidden" name="kind" value={kindFilter} />}
            <input
              type="search"
              name="q"
              defaultValue={search}
              placeholder="Search the timeline…"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
            <button
              type="submit"
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              Search
            </button>
          </form>

          <div className="flex flex-wrap gap-2 text-xs">
            <Link
              href={withParams("")}
              className={
                !kindFilter
                  ? "rounded-full bg-indigo-600 px-2.5 py-1 font-medium text-white"
                  : "rounded-full bg-white px-2.5 py-1 font-medium text-slate-600 ring-1 ring-inset ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700"
              }
            >
              All
            </Link>
            {KINDS.map((k) => (
              <Link
                key={k}
                href={withParams(k)}
                className={
                  kindFilter === k
                    ? "rounded-full bg-indigo-600 px-2.5 py-1 font-medium text-white"
                    : "rounded-full bg-white px-2.5 py-1 font-medium text-slate-600 ring-1 ring-inset ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700"
                }
              >
                {k}
              </Link>
            ))}
          </div>

          {(timeline ?? []).length === 0 ? (
            <EmptyState
              title="Nothing here"
              description={
                search || kindFilter
                  ? "No timeline entries match those filters."
                  : "Interactions will appear here as they happen."
              }
            />
          ) : (
            <ol className="relative space-y-4 border-l border-slate-200 pl-6 dark:border-slate-800">
              {(timeline ?? []).map((entry) => (
                <li key={entry.id} className="relative">
                  <span className="absolute -left-[31px] flex h-5 w-5 items-center justify-center rounded-full bg-white text-xs ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
                    {KIND_ICONS[entry.kind] ?? "•"}
                  </span>
                  <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {entry.title}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {new Date(entry.occurred_at).toLocaleString()} · {entry.kind}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
