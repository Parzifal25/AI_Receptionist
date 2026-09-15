import type { Metadata } from "next";
import Link from "next/link";
import { requireBusiness } from "@halo/tenancy/auth";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { Card, EmptyState } from "@/components/ui/card";

export const metadata: Metadata = { title: "Customers — AI Receptionist" };

const STAGE_BADGES: Record<string, string> = {
  lead: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  engaged: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  booked: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  customer: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  lost: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

/** Escapes user input for a PostgREST ilike pattern. */
function likePattern(q: string): string {
  return `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { businessId } = await requireBusiness();
  const { q } = await searchParams;
  const search = (q ?? "").trim().slice(0, 100);

  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("customers")
    .select("id, name, email, phone, stage, total_appointments, revenue_total, last_seen_at")
    .eq("business_id", businessId)
    .is("merged_into", null)
    .order("last_seen_at", { ascending: false })
    .limit(200);
  if (search) {
    const pattern = likePattern(search);
    query = query.or(`name.ilike.${pattern},email.ilike.${pattern},phone.ilike.${pattern}`);
  }
  const { data: customers } = await query;

  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Customers</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          One record per person, built automatically from every conversation, booking, and visit.
        </p>
      </div>

      <form className="flex max-w-md gap-2" action="/dashboard/customers" method="get">
        <input
          type="search"
          name="q"
          defaultValue={search}
          placeholder="Search by name, email, or phone…"
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        <button
          type="submit"
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
        >
          Search
        </button>
      </form>

      <Card>
        {(customers ?? []).length === 0 ? (
          <EmptyState
            title={search ? "No matches" : "No customers yet"}
            description={
              search
                ? "No customer matches that search."
                : "Customers appear here automatically as your receptionist captures leads and bookings."
            }
          />
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {(customers ?? []).map((customer) => (
              <li key={customer.id}>
                <Link
                  href={`/dashboard/customers/${customer.id}`}
                  className="flex flex-wrap items-center gap-4 px-6 py-4 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                      {customer.name || customer.email || customer.phone || "Unknown"}
                    </p>
                    <p className="mt-0.5 truncate text-sm text-slate-500 dark:text-slate-400">
                      {[customer.email, customer.phone].filter(Boolean).join(" · ") || "No contact info"}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STAGE_BADGES[customer.stage] ?? STAGE_BADGES.lead}`}
                  >
                    {customer.stage}
                  </span>
                  <div className="text-right text-sm">
                    <p className="font-medium text-slate-900 dark:text-slate-100">
                      {customer.total_appointments} appt{customer.total_appointments === 1 ? "" : "s"}
                    </p>
                    {Number(customer.revenue_total) > 0 && (
                      <p className="text-slate-500 dark:text-slate-400">
                        {Number(customer.revenue_total).toFixed(2)} revenue
                      </p>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
