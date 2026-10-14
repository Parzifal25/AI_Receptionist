import { NextResponse } from "next/server";
import { requireBusiness } from "@halo/tenancy/auth";
import { AppError } from "@halo/core/errors/app-error";
import { withErrorHandling } from "@/lib/api/respond";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { getLLMProvider } from "@halo/providers/llm/factory";
import { validateProductionReadiness } from "@/lib/startup-check";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling("admin.system-status", async () => {
  const { role, businessId } = await requireBusiness();
  if (role !== "admin" && role !== "owner") {
    throw AppError.forbidden("Admin access required");
  }

  const adminClient = getAdminClient();
  const llm = getLLMProvider();
  
  const [llmHealthy, readiness] = await Promise.all([
    llm.isHealthy(),
    validateProductionReadiness(),
  ]);

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [pendingReminders, dueReminders, pendingRuns, processingRuns, failedRuns, deadLetterRuns, latencyEvents, calendarConnections] = await Promise.all([
    adminClient.from("appointment_reminders").select("id", { count: "exact", head: true }).eq("business_id", businessId).eq("status", "scheduled"),
    adminClient.from("appointment_reminders").select("send_at", { count: "exact" }).eq("business_id", businessId).eq("status", "scheduled").lte("send_at", new Date().toISOString()).order("send_at", { ascending: true }).limit(1),
    adminClient.from("workflow_runs").select("id", { count: "exact", head: true }).eq("business_id", businessId).eq("status", "pending"),
    adminClient.from("workflow_runs").select("id", { count: "exact", head: true }).eq("business_id", businessId).eq("status", "processing"),
    adminClient.from("workflow_runs").select("id", { count: "exact", head: true }).eq("business_id", businessId).eq("status", "failed"),
    adminClient.from("workflow_runs").select("id", { count: "exact", head: true }).eq("business_id", businessId).eq("status", "dead_letter"),
    adminClient.from("usage_events").select("created_at, metadata").eq("business_id", businessId).eq("event_type", "message_sent").gte("created_at", since).order("created_at", { ascending: false }).limit(500),
    adminClient.from("calendar_connections").select("id, provider").eq("business_id", businessId),
  ]);

  if ([pendingReminders, dueReminders, pendingRuns, processingRuns, failedRuns, deadLetterRuns, latencyEvents, calendarConnections].some((result) => result.error)
      || [pendingReminders, dueReminders, pendingRuns, processingRuns, failedRuns, deadLetterRuns].some((result) => result.count === null)
      || !Array.isArray(latencyEvents.data) || !Array.isArray(calendarConnections.data)) {
    return NextResponse.json({ error: { code: "MONITORING_UNAVAILABLE", message: "Operational data is temporarily unavailable" } }, { status: 503 });
  }

  const connectedCalendars = (calendarConnections.data ?? []).length;
  const disconnectedCalendars = 0;
  const latencies = (latencyEvents.data ?? []).flatMap((event) => {
    const value = (event.metadata as Record<string, unknown> | null)?.latencyMs;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? [value] : [];
  }).sort((a, b) => a - b);
  const percentile = (p: number) => latencies.length ? latencies[Math.ceil(p * latencies.length) - 1] : null;
  const oldestDueAt = (dueReminders.data ?? [])[0]?.send_at;
  const latestObservationAt = (latencyEvents.data ?? []).map((event) => event.created_at).filter((value): value is string => typeof value === "string").sort().at(-1) ?? null;

  return NextResponse.json({
    data: {
      status: readiness.ready && llmHealthy && (dueReminders.count ?? 0) === 0 && (failedRuns.count ?? 0) === 0 && (deadLetterRuns.count ?? 0) === 0 ? "ok" : "degraded",
      llm: { provider: llm.name, healthy: llmHealthy },
      database: readiness.database,
      providers: readiness.providers,
      queues: {
        pendingReminders: pendingReminders.count ?? 0,
        overdueReminders: dueReminders.count ?? 0,
        oldestOverdueReminderAgeMs: oldestDueAt ? Math.max(0, Date.now() - Date.parse(oldestDueAt)) : null,
        pendingWorkflowRuns: pendingRuns.count ?? 0,
        processingWorkflowRuns: processingRuns.count ?? 0,
        failedWorkflowRuns: failedRuns.count ?? 0,
        deadLetterWorkflowRuns: deadLetterRuns.count ?? 0,
      },
      providerTelemetry: {
        successfulTurnLatencyMs24h: { samples: latencies.length, p50: percentile(0.5), p95: percentile(0.95), sampleLimit: 500 },
        latestObservationAgeMs: latestObservationAt ? Math.max(0, Date.now() - Date.parse(latestObservationAt)) : null,
        freshness: latestObservationAt ? "observed" : "no_observations",
        failureRate: null,
        failureRateStatus: "unavailable_without_durable_provider_failure_metrics",
      },
      calendars: {
        active: connectedCalendars,
        disconnected: disconnectedCalendars,
      },
      time: new Date().toISOString(),
    },
  });
});
