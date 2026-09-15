import type { Metadata } from "next";
import Link from "next/link";
import { requireBusiness } from "@halo/tenancy/auth";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { Card, EmptyState } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { deleteLead, updateLeadStatus } from "@/features/leads/actions";
import type { LeadStatus } from "@halo/core/domain/types";

export const metadata: Metadata = { title: "Leads — AI Receptionist" };

const STATUSES: LeadStatus[] = ["new", "contacted", "qualified", "closed"];

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { businessId } = await requireBusiness();
  const params = await searchParams;
  const statusFilter = STATUSES.includes(params.status as LeadStatus)
    ? (params.status as LeadStatus)
    : null;

  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("leads")
    .select("id, conversation_id, name, email, phone, intent, status, score, temperature, created_at")
    .eq("business_id", businessId)
    // Hottest first — the whole point is telling the owner who to call now.
    .order("score", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);
  if (statusFilter) query = query.eq("status", statusFilter);
  const { data: leads } = await query;

  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Leads</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Contact details your receptionist captured from interested visitors.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <FilterLink href="/dashboard/leads" active={!statusFilter} label="All" />
        {STATUSES.map((status) => (
          <FilterLink
            key={status}
            href={`/dashboard/leads?status=${status}`}
            active={statusFilter === status}
            label={status[0].toUpperCase() + status.slice(1)}
          />
        ))}
      </div>

      <Card>
        {(leads ?? []).length === 0 ? (
          <EmptyState
            title="No leads yet"
            description="When visitors share their contact details with your receptionist, they show up here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="px-6 py-3 font-medium">Priority</th>
                  <th className="px-6 py-3 font-medium">Contact</th>
                  <th className="px-6 py-3 font-medium">Intent</th>
                  <th className="px-6 py-3 font-medium">Captured</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {leads!.map((lead) => (
                  <tr key={lead.id}>
                    <td className="whitespace-nowrap px-6 py-4">
                      <TemperatureBadge
                        temperature={lead.temperature as "hot" | "warm" | "cold"}
                        score={lead.score ?? 0}
                      />
                    </td>
                    <td className="px-6 py-4">
                      <p className="font-medium text-slate-900 dark:text-slate-100">
                        {lead.name || "Unknown visitor"}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {[lead.email, lead.phone].filter(Boolean).join(" · ") || "No contact info"}
                      </p>
                    </td>
                    <td className="max-w-56 px-6 py-4 text-slate-600 dark:text-slate-300">
                      {lead.intent || "—"}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-slate-500 dark:text-slate-400">
                      {new Date(lead.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4">
                      <form action={updateLeadStatus}>
                        <input type="hidden" name="id" value={lead.id} />
                        <select
                          name="status"
                          defaultValue={lead.status}
                          className="rounded-md border-0 bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700"
                        >
                          {STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {status[0].toUpperCase() + status.slice(1)}
                            </option>
                          ))}
                        </select>
                        <Button type="submit" variant="ghost" size="sm" className="ml-1">
                          Save
                        </Button>
                      </form>
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-right">
                      {lead.conversation_id && (
                        <Link
                          href={`/dashboard/conversations/${lead.conversation_id}`}
                          className="mr-3 text-xs font-medium text-indigo-600 hover:text-indigo-500"
                        >
                          Transcript
                        </Link>
                      )}
                      <form action={deleteLead} className="inline">
                        <input type="hidden" name="id" value={lead.id} />
                        <Button type="submit" variant="ghost" size="sm">
                          Delete
                        </Button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function TemperatureBadge({
  temperature,
  score,
}: {
  temperature: "hot" | "warm" | "cold";
  score: number;
}) {
  const styles: Record<typeof temperature, string> = {
    hot: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
    warm: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    cold: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
  };
  const label = { hot: "🔥 Hot", warm: "Warm", cold: "Cold" }[temperature];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${styles[temperature]}`}
      title={`Qualification score ${score}/100`}
    >
      {label}
      <span className="opacity-60">{score}</span>
    </span>
  );
}

function FilterLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={
        active
          ? "rounded-full bg-indigo-600 px-3 py-1 font-medium text-white"
          : "rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
      }
    >
      {label}
    </Link>
  );
}
