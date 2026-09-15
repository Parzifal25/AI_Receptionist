import { NextResponse } from "next/server";
import { requireBusiness } from "@halo/tenancy/auth";
import { AppError } from "@halo/core/errors/app-error";
import { withErrorHandling } from "@/lib/api/respond";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { getLLMProvider } from "@halo/providers/llm/factory";
import { validateProductionReadiness } from "@/lib/startup-check";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling("admin.system-status", async () => {
  const { role } = await requireBusiness();
  if (role !== "admin" && role !== "owner") {
    throw AppError.forbidden("Admin access required");
  }

  const adminClient = getAdminClient();
  const llm = getLLMProvider();
  
  const [llmHealthy, readiness] = await Promise.all([
    llm.isHealthy(),
    validateProductionReadiness(),
  ]);

  const [pendingReminders, failedRuns, calendarConnections] = await Promise.all([
    adminClient.from("appointment_reminders").select("id", { count: "exact", head: true }).eq("status", "scheduled"),
    adminClient.from("workflow_runs").select("id", { count: "exact", head: true }).eq("status", "failed"),
    adminClient.from("calendar_connections").select("id, provider"),
  ]);

  const connectedCalendars = (calendarConnections.data ?? []).length;
  const disconnectedCalendars = 0;

  return NextResponse.json({
    data: {
      status: readiness.ready ? "ok" : "degraded",
      llm: { provider: llm.name, healthy: llmHealthy },
      database: { connected: readiness.ready && !readiness.errors.some(e => e.includes("Database")) },
      providers: readiness.providers,
      queues: {
        pendingReminders: pendingReminders.count ?? 0,
        failedWorkflowRuns: failedRuns.count ?? 0,
      },
      calendars: {
        active: connectedCalendars,
        disconnected: disconnectedCalendars,
      },
      time: new Date().toISOString(),
    },
  });
});
