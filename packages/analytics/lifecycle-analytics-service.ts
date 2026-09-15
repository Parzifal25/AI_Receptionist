import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppointmentStatus } from "@halo/core/domain/scheduling";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { AppError } from "@halo/core/errors/app-error";
import { logger } from "@halo/platform/logger";
import {
  computeLifecycleMetrics,
  type LifecycleMetrics,
} from "./lifecycle-analytics";

const log = logger.child({ service: "lifecycle-analytics" });

/** Feeds computeLifecycleMetrics from Supabase for one business + period. */
export class LifecycleAnalyticsService {
  constructor(private readonly db: SupabaseClient = getAdminClient()) {}

  async getMetrics(businessId: string, periodDays = 30): Promise<LifecycleMetrics> {
    const since = new Date(Date.now() - periodDays * 86_400_000).toISOString();

    const [usage, appointments, customers, staff] = await Promise.all([
      this.db
        .from("usage_events")
        .select("event_type")
        .eq("business_id", businessId)
        .gte("created_at", since),
      this.db
        .from("appointments")
        .select("status, starts_at, ends_at, timezone")
        .eq("business_id", businessId)
        .gte("starts_at", since),
      this.db
        .from("customers")
        .select("total_appointments, revenue_total")
        .eq("business_id", businessId)
        .is("merged_into", null),
      this.db
        .from("staff_members")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("is_active", true),
    ]);

    const firstError = usage.error ?? appointments.error ?? customers.error ?? staff.error;
    if (firstError) {
      log.error("analytics query failed", { error: firstError.message });
      throw AppError.internal();
    }

    const usageCounts: Record<string, number> = {};
    for (const row of usage.data ?? []) {
      usageCounts[row.event_type] = (usageCounts[row.event_type] ?? 0) + 1;
    }

    return computeLifecycleMetrics({
      usageCounts,
      appointments: (appointments.data ?? []).map((row) => ({
        status: row.status as AppointmentStatus,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        timezone: row.timezone,
      })),
      customers: (customers.data ?? []).map((row) => ({
        totalAppointments: row.total_appointments,
        revenueTotal: Number(row.revenue_total) || 0,
      })),
      staffCount: staff.count ?? 0,
      periodDays,
    });
  }
}
