import type { Metadata } from "next";
import Link from "next/link";
import { requireBusiness } from "@/lib/auth";
import { LifecycleAnalyticsService } from "@/core/services/analytics/lifecycle-analytics-service";
import { Card, CardBody, CardHeader } from "@/components/ui/card";

export const metadata: Metadata = { title: "Analytics — AI Receptionist" };
export const dynamic = "force-dynamic";

const PERIODS = [7, 30, 90] as const;

const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);

function hourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${hour < 12 ? "am" : "pm"}`;
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { businessId } = await requireBusiness();
  const params = await searchParams;
  const days = PERIODS.includes(Number(params.days) as (typeof PERIODS)[number])
    ? (Number(params.days) as (typeof PERIODS)[number])
    : 30;

  const metrics = await new LifecycleAnalyticsService().getMetrics(businessId, days);
  const peak = metrics.peakBookingHours.slice(0, 8);
  const peakMax = peak[0]?.count ?? 0;

  const tiles: Array<{ label: string; value: string; hint: string }> = [
    {
      label: "Booking conversion",
      value: pct(metrics.bookingConversionRate),
      hint: `${metrics.counts.booked} bookings from ${metrics.counts.conversations} conversations`,
    },
    {
      label: "Reminder success",
      value: pct(metrics.reminderSuccessRate),
      hint: `${metrics.counts.remindersSent} delivered, ${metrics.counts.remindersFailed} failed`,
    },
    {
      label: "No-show rate",
      value: pct(metrics.noShowRate),
      hint: `${metrics.counts.noShows} no-shows vs ${metrics.counts.completed} completed`,
    },
    {
      label: "Review rate",
      value: pct(metrics.reviewRate),
      hint: `${metrics.feedbackReceived} responses (${metrics.reviewRequests} asked)`,
    },
    {
      label: "Customer lifetime value",
      value:
        metrics.customerLifetimeValue === null ? "—" : metrics.customerLifetimeValue.toFixed(2),
      hint: `${metrics.revenueTotal.toFixed(2)} total attributed revenue`,
    },
    {
      label: "Repeat customers",
      value: pct(metrics.repeatCustomerRate),
      hint: `${metrics.repeatCustomers} of ${metrics.totalCustomers} came back`,
    },
    {
      label: "Appointment utilization",
      value: pct(metrics.appointmentUtilization),
      hint: `${Math.round(metrics.bookedMinutes / 60)}h booked (vs 8h staff days)`,
    },
    {
      label: "AI success rate",
      value: pct(metrics.aiSuccessRate),
      hint: "Messages answered without an unanswered-question flag",
    },
  ];

  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Analytics</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Business health across the whole customer lifecycle.
        </p>
      </div>

      <div className="flex gap-2 text-sm">
        {PERIODS.map((period) => (
          <Link
            key={period}
            href={`/dashboard/analytics?days=${period}`}
            className={
              days === period
                ? "rounded-full bg-indigo-600 px-3 py-1 font-medium text-white"
                : "rounded-full bg-white px-3 py-1 font-medium text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700"
            }
          >
            {period} days
          </Link>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <div
            key={tile.label}
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
          >
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {tile.label}
            </p>
            <p className="mt-2 text-3xl font-bold tabular-nums text-slate-900 dark:text-white">
              {tile.value}
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{tile.hint}</p>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader
          title="Peak booking hours"
          description={`Appointment start times over the last ${days} days, in each booking's local time.`}
        />
        <CardBody>
          {peak.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              No appointments in this period yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {peak.map((entry) => (
                <li key={entry.hour} className="flex items-center gap-3 text-sm">
                  <span className="w-12 shrink-0 text-right tabular-nums text-slate-500 dark:text-slate-400">
                    {hourLabel(entry.hour)}
                  </span>
                  <span className="h-4 flex-1 overflow-hidden rounded-r-[4px] bg-slate-100 dark:bg-slate-800">
                    <span
                      className="block h-full rounded-r-[4px] bg-indigo-600"
                      style={{ width: `${peakMax > 0 ? Math.max(4, (entry.count / peakMax) * 100) : 0}%` }}
                    />
                  </span>
                  <span className="w-8 shrink-0 tabular-nums text-slate-700 dark:text-slate-200">
                    {entry.count}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <p className="text-xs text-slate-400 dark:text-slate-500">
        Revenue and lifetime value cover all time (customer records); rates cover the selected
        period. Utilization assumes an 8-hour bookable day per active staff member.
      </p>
    </div>
  );
}
