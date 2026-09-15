import type { Metadata } from "next";
import { requireBusiness } from "@halo/tenancy/auth";
import { Card, CardBody } from "@/components/ui/card";
import { LifecycleAnalyticsService } from "@halo/analytics/lifecycle-analytics-service";
import { OperationsAnalyticsService } from "@halo/analytics/operations-analytics-service";

export const metadata: Metadata = { title: "Operations — AI Receptionist" };

function formatPercent(value: number | null): string {
  if (value === null) return "N/A";
  return `${Math.round(value * 100)}%`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function formatTime(hour: number): string {
  const ampm = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return `${h}:00 ${ampm}`;
}

export default async function OperationsPage() {
  const { businessId } = await requireBusiness();

  const [lifecycle, ops] = await Promise.all([
    new LifecycleAnalyticsService().getMetrics(businessId, 30),
    new OperationsAnalyticsService().getMetrics(businessId, 30),
  ]);

  const peakHourStr = ops.peakBookingHours.length > 0
    ? formatTime(ops.peakBookingHours[0].hour)
    : "N/A";

  const cards = [
    { label: "Appointments (30d)", value: formatNumber(lifecycle.counts.booked), status: "good" },
    { label: "Revenue (All-time)", value: formatCurrency(lifecycle.revenueTotal), status: "good" },
    { label: "Reminder Success Rate", value: formatPercent(ops.reminderSuccessRate), status: ops.reminderSuccessRate && ops.reminderSuccessRate < 0.9 ? "warning" : "good" },
    { label: "Email Delivery", value: formatNumber(ops.emailDeliveryCount), status: "good" },
    { label: "WhatsApp Delivery", value: formatNumber(ops.whatsappDeliveryCount), status: "good" },
    { label: "Call Statistics", value: formatNumber(ops.voiceDeliveryCount), status: "good" },
    { label: "AI Success Rate", value: formatPercent(lifecycle.aiSuccessRate), status: lifecycle.aiSuccessRate && lifecycle.aiSuccessRate < 0.8 ? "warning" : "good" },
    { label: "Booking Conversion", value: formatPercent(lifecycle.bookingConversionRate), status: "good" },
    { label: "No-show Rate", value: formatPercent(lifecycle.noShowRate), status: lifecycle.noShowRate && lifecycle.noShowRate > 0.15 ? "critical" : "good" },
    { label: "Avg Response Time", value: ops.averageResponseTime ? `${ops.averageResponseTime}m` : "N/A", status: "good" },
    { label: "Peak Booking Hour", value: peakHourStr, status: "good" },
    { label: "Repeat Customers", value: formatNumber(lifecycle.repeatCustomers), status: "good" },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Operations</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Monitor your platform operations, delivery stats, and performance metrics.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {cards.map((card) => {
          let valueColor = "text-slate-900 dark:text-white";
          if (card.status === "good") valueColor = "text-green-600 dark:text-green-500";
          if (card.status === "warning") valueColor = "text-amber-600 dark:text-amber-500";
          if (card.status === "critical") valueColor = "text-red-600 dark:text-red-500";

          return (
            <Card key={card.label}>
              <CardBody>
                <p className="text-sm font-medium text-slate-500 dark:text-slate-400">{card.label}</p>
                <p className={`mt-2 text-3xl font-bold ${valueColor}`}>{card.value}</p>
              </CardBody>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
