import type { Metadata } from "next";
import Link from "next/link";
import { requireBusiness } from "@halo/tenancy/auth";
import { createSupabaseServerClient } from "@halo/tenancy/supabase/server";
import { Card, EmptyState } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { canTransition } from "@halo/scheduling/appointment-state";
import type { AppointmentStatus } from "@halo/core/domain/scheduling";
import { formatInTz } from "@halo/scheduling/timezone";
import { updateAppointmentLifecycle } from "@/features/appointments/actions";

export const metadata: Metadata = { title: "Appointments — AI Receptionist" };

const VIEWS = ["today", "upcoming", "past"] as const;
type View = (typeof VIEWS)[number];

const STATUS_BADGES: Record<AppointmentStatus, string> = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  confirmed: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  checked_in: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  running_late: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  in_progress: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  cancelled: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
  no_show: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

const STATUS_LABELS: Record<AppointmentStatus, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  checked_in: "Checked in",
  running_late: "Running late",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

/** Day-of actions in the order staff use them. */
const ACTIONS: Array<{ status: AppointmentStatus; label: string }> = [
  { status: "checked_in", label: "Check in" },
  { status: "running_late", label: "Late" },
  { status: "in_progress", label: "Start" },
  { status: "completed", label: "Complete" },
  { status: "no_show", label: "No-show" },
];

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { businessId } = await requireBusiness();
  const params = await searchParams;
  const view: View = VIEWS.includes(params.view as View) ? (params.view as View) : "today";

  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay.getTime() + 86_400_000);

  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("appointments")
    .select("id, service_name, visitor_name, visitor_phone, visitor_email, starts_at, ends_at, timezone, status")
    .eq("business_id", businessId)
    .limit(200);

  if (view === "today") {
    query = query
      .gte("starts_at", startOfDay.toISOString())
      .lt("starts_at", endOfDay.toISOString())
      .order("starts_at", { ascending: true });
  } else if (view === "upcoming") {
    query = query.gte("starts_at", endOfDay.toISOString()).order("starts_at", { ascending: true });
  } else {
    query = query.lt("starts_at", startOfDay.toISOString()).order("starts_at", { ascending: false });
  }
  const { data: appointments } = await query;

  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Appointments</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Track every visit from booked to completed — check-ins, late arrivals, and no-shows.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        {VIEWS.map((v) => (
          <Link
            key={v}
            href={`/dashboard/appointments?view=${v}`}
            className={
              view === v
                ? "rounded-full bg-indigo-600 px-3 py-1 font-medium text-white"
                : "rounded-full bg-white px-3 py-1 font-medium text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700"
            }
          >
            {v[0].toUpperCase() + v.slice(1)}
          </Link>
        ))}
      </div>

      <Card>
        {(appointments ?? []).length === 0 ? (
          <EmptyState
            title="No appointments"
            description={
              view === "today"
                ? "Nothing on the books today."
                : view === "upcoming"
                  ? "No future appointments yet — your receptionist books them automatically."
                  : "No past appointments in this range."
            }
          />
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {(appointments ?? []).map((appointment) => {
              const status = appointment.status as AppointmentStatus;
              const available = ACTIONS.filter((a) => canTransition(status, a.status));
              return (
                <li key={appointment.id} className="flex flex-wrap items-center gap-4 px-6 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                      {appointment.visitor_name || "Visitor"} —{" "}
                      {appointment.service_name || "Appointment"}
                    </p>
                    <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                      {formatInTz(appointment.starts_at, appointment.timezone)}
                      {appointment.visitor_phone && ` · ${appointment.visitor_phone}`}
                      {!appointment.visitor_phone &&
                        appointment.visitor_email &&
                        ` · ${appointment.visitor_email}`}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_BADGES[status]}`}
                  >
                    {STATUS_LABELS[status]}
                  </span>
                  {available.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {available.map((action) => (
                        <form key={action.status} action={updateAppointmentLifecycle}>
                          <input type="hidden" name="id" value={appointment.id} />
                          <input type="hidden" name="status" value={action.status} />
                          <Button
                            type="submit"
                            size="sm"
                            variant={action.status === "completed" ? "primary" : "secondary"}
                          >
                            {action.label}
                          </Button>
                        </form>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
