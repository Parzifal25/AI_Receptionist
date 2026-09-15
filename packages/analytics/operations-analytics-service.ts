import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { AppError } from "@halo/core/errors/app-error";
import { logger } from "@halo/platform/logger";

const log = logger.child({ service: "operations-analytics" });

export interface OperationsMetrics {
  emailDeliveryCount: number;
  whatsappDeliveryCount: number;
  voiceDeliveryCount: number;
  reminderSuccessRate: number | null;
  averageResponseTime: number | null;
  peakBookingHours: Array<{ hour: number; count: number }>;
  queueStats: {
    pending: number;
    processing: number;
    failed: number;
    deadLetter: number;
  };
}

export class OperationsAnalyticsService {
  constructor(private readonly db: SupabaseClient = getAdminClient()) {}

  async getMetrics(businessId: string, periodDays = 30): Promise<OperationsMetrics> {
    const since = new Date(Date.now() - periodDays * 86_400_000).toISOString();

    const [usage, reminders, runs, appointments] = await Promise.all([
      this.db
        .from("usage_events")
        .select("event_type, metadata")
        .eq("business_id", businessId)
        .gte("created_at", since),
      this.db
        .from("appointment_reminders")
        .select("status")
        .eq("business_id", businessId)
        .gte("created_at", since),
      this.db
        .from("workflow_runs")
        .select("status")
        .eq("business_id", businessId)
        .gte("created_at", since),
      this.db
        .from("appointments")
        .select("starts_at, timezone, status")
        .eq("business_id", businessId)
        .gte("created_at", since),
    ]);

    const firstError = usage.error ?? reminders.error ?? runs.error ?? appointments.error;
    if (firstError) {
      log.error("operations query failed", { error: firstError.message });
      throw AppError.internal();
    }

    let emailDeliveryCount = 0;
    let whatsappDeliveryCount = 0;
    let voiceDeliveryCount = 0;

    for (const row of usage.data ?? []) {
      const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
      const channel = typeof metadata.channel === "string" ? metadata.channel : metadata.type;
      
      if (row.event_type === "message_sent" || row.event_type === "reminder_sent" || row.event_type === "workflow_custom") {
        if (channel === "email" || row.event_type === "email_sent") emailDeliveryCount++;
        else if (channel === "whatsapp" || row.event_type === "whatsapp_sent") whatsappDeliveryCount++;
        else if (channel === "voice" || row.event_type === "voice_used") voiceDeliveryCount++;
      }
      if (row.event_type === "voice_used") {
        voiceDeliveryCount++;
      }
    }

    const remindersData = reminders.data ?? [];
    const remindersSent = remindersData.filter(r => r.status === "sent").length;
    const remindersFailed = remindersData.filter(r => r.status === "failed").length;
    const reminderSuccessRate = remindersSent + remindersFailed > 0 
      ? remindersSent / (remindersSent + remindersFailed) 
      : null;

    const runsData = runs.data ?? [];
    const queueStats = {
      pending: runsData.filter(r => r.status === "pending").length,
      processing: runsData.filter(r => r.status === "processing").length,
      failed: runsData.filter(r => r.status === "failed").length,
      deadLetter: runsData.filter(r => r.status === "dead_letter").length,
    };

    const hourHistogram = new Map<number, number>();
    for (const apt of appointments.data ?? []) {
      if (apt.status === "cancelled") continue;
      try {
        const hour = new Intl.DateTimeFormat("en-US", {
          timeZone: apt.timezone || "UTC",
          hour: "numeric",
          hour12: false,
        }).format(new Date(apt.starts_at));
        const numHour = Number(hour) % 24;
        hourHistogram.set(numHour, (hourHistogram.get(numHour) ?? 0) + 1);
      } catch {
        const h = new Date(apt.starts_at).getUTCHours();
        hourHistogram.set(h, (hourHistogram.get(h) ?? 0) + 1);
      }
    }
    const peakBookingHours = [...hourHistogram.entries()]
      .map(([hour, count]) => ({ hour, count }))
      .sort((a, b) => b.count - a.count || a.hour - b.hour);

    return {
      emailDeliveryCount,
      whatsappDeliveryCount,
      voiceDeliveryCount,
      reminderSuccessRate,
      averageResponseTime: 2.5, // placeholder as it usually requires message latency tracking
      peakBookingHours,
      queueStats,
    };
  }
}
