import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireBusiness } from "@halo/tenancy/auth";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { getLLMProvider } from "@halo/providers/llm/factory";
import { validateProductionReadiness } from "@/lib/startup-check";
import { Card, CardBody, CardHeader } from "@/components/ui/card";

export const metadata: Metadata = { title: "System Admin — AI Receptionist" };

export default async function AdminPage() {
  const { role, businessId } = await requireBusiness();
  if (role !== "admin" && role !== "owner") {
    redirect("/dashboard");
  }

  const supabase = getAdminClient();
  const llm = getLLMProvider();

  const [
    readiness,
    llmHealthy,
    workflowCounts,
    reminderCounts,
    webhookLogs,
    calendars,
  ] = await Promise.all([
    validateProductionReadiness(),
    llm.isHealthy(),
    supabase.from("workflow_runs").select("status").eq("business_id", businessId),
    supabase.from("appointment_reminders").select("status").eq("business_id", businessId),
    supabase
      .from("usage_events")
      .select("id, event_type, metadata, created_at")
      .eq("business_id", businessId)
      .in("event_type", ["workflow_custom", "webhook_delivered"])
      .order("created_at", { ascending: false })
      .limit(10),
    supabase.from("calendar_connections").select("provider").eq("business_id", businessId),
  ]);

  const workflowData = workflowCounts.data ?? [];
  const reminderData = reminderCounts.data ?? [];
  const calendarData = calendars.data ?? [];
  
  const queueStats = {
    workflowPending: workflowData.filter(r => r.status === "pending").length,
    workflowProcessing: workflowData.filter(r => r.status === "processing").length,
    workflowFailed: workflowData.filter(r => r.status === "failed").length,
    workflowDead: workflowData.filter(r => r.status === "dead_letter").length,
    remindersScheduled: reminderData.filter(r => r.status === "scheduled").length,
    remindersFailed: reminderData.filter(r => r.status === "failed").length,
  };

  const calActive = calendarData.length;
  const calDisconnected = 0;

  const logs = webhookLogs.data ?? [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">System Administration</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Monitor system health, queue status, and third-party integrations.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="System Health" description="Core platform health status" />
          <CardBody>
            <div className="space-y-4">
              <div className="flex justify-between border-b border-slate-200 pb-2 dark:border-slate-800">
                <span className="text-sm text-slate-600 dark:text-slate-300">Database Status</span>
                <span className={readiness.errors.some(e => e.includes("Database")) ? "text-red-500 font-medium text-sm" : "text-green-500 font-medium text-sm"}>
                  {readiness.errors.some(e => e.includes("Database")) ? "Disconnected" : "Connected"}
                </span>
              </div>
              <div className="flex justify-between border-b border-slate-200 pb-2 dark:border-slate-800">
                <span className="text-sm text-slate-600 dark:text-slate-300">System Uptime</span>
                <span className="text-green-500 font-medium text-sm">Online</span>
              </div>
              {readiness.errors.length > 0 && (
                <div className="rounded-md bg-red-50 p-4 dark:bg-red-900/20">
                  <h3 className="text-sm font-medium text-red-800 dark:text-red-200">Recent Errors</h3>
                  <ul className="mt-2 list-disc pl-5 text-sm text-red-700 dark:text-red-300">
                    {readiness.errors.map((err, i) => <li key={i}>{err}</li>)}
                  </ul>
                </div>
              )}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Provider Status" description="Third-party API connections" />
          <CardBody>
            <div className="space-y-4">
              <div className="flex justify-between border-b border-slate-200 pb-2 dark:border-slate-800">
                <span className="text-sm text-slate-600 dark:text-slate-300">LLM ({llm.name})</span>
                <span className={llmHealthy ? "text-green-500 font-medium text-sm" : "text-red-500 font-medium text-sm"}>
                  {llmHealthy ? "Healthy" : "Degraded"}
                </span>
              </div>
              <div className="flex justify-between border-b border-slate-200 pb-2 dark:border-slate-800">
                <span className="text-sm text-slate-600 dark:text-slate-300">Email (Resend)</span>
                <span className={readiness.providers.email ? "text-green-500 font-medium text-sm" : "text-slate-500 font-medium text-sm"}>
                  {readiness.providers.email ? "Configured" : "Not Configured"}
                </span>
              </div>
              <div className="flex justify-between border-b border-slate-200 pb-2 dark:border-slate-800">
                <span className="text-sm text-slate-600 dark:text-slate-300">WhatsApp</span>
                <span className={readiness.providers.whatsapp ? "text-green-500 font-medium text-sm" : "text-slate-500 font-medium text-sm"}>
                  {readiness.providers.whatsapp ? "Configured" : "Not Configured"}
                </span>
              </div>
              <div className="flex justify-between border-b border-slate-200 pb-2 dark:border-slate-800">
                <span className="text-sm text-slate-600 dark:text-slate-300">Calendar Connections</span>
                <span className={calActive > 0 ? "text-green-500 font-medium text-sm" : "text-amber-500 font-medium text-sm"}>
                  {calActive} Active, {calDisconnected} Disconnected
                </span>
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Job Queue Monitor" description="Background task statistics" />
          <CardBody>
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Workflow Runs</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
                  <p className="text-xs text-slate-500">Pending</p>
                  <p className="text-xl font-bold text-slate-900 dark:text-white">{queueStats.workflowPending}</p>
                </div>
                <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
                  <p className="text-xs text-slate-500">Processing</p>
                  <p className="text-xl font-bold text-blue-600 dark:text-blue-400">{queueStats.workflowProcessing}</p>
                </div>
                <div className="rounded-lg bg-red-50 p-3 dark:bg-red-900/10">
                  <p className="text-xs text-red-500">Failed</p>
                  <p className="text-xl font-bold text-red-600 dark:text-red-500">{queueStats.workflowFailed}</p>
                </div>
                <div className="rounded-lg bg-amber-50 p-3 dark:bg-amber-900/10">
                  <p className="text-xs text-amber-600">Dead Letter</p>
                  <p className="text-xl font-bold text-amber-700 dark:text-amber-500">{queueStats.workflowDead}</p>
                </div>
              </div>

              <h3 className="mt-6 text-sm font-semibold text-slate-900 dark:text-white">Appointment Reminders</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
                  <p className="text-xs text-slate-500">Scheduled</p>
                  <p className="text-xl font-bold text-slate-900 dark:text-white">{queueStats.remindersScheduled}</p>
                </div>
                <div className="rounded-lg bg-red-50 p-3 dark:bg-red-900/10">
                  <p className="text-xs text-red-500">Failed</p>
                  <p className="text-xl font-bold text-red-600 dark:text-red-500">{queueStats.remindersFailed}</p>
                </div>
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Webhook Logs" description="Recent webhook deliveries" />
          <CardBody>
            {logs.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">No recent webhook deliveries.</p>
            ) : (
              <ul className="space-y-3">
                {logs.map((log) => (
                  <li key={log.id} className="border-b border-slate-100 pb-3 last:border-0 last:pb-0 dark:border-slate-800">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-slate-900 dark:text-white">
                        {log.event_type}
                      </span>
                      <span className="text-xs text-slate-500">
                        {new Date(log.created_at).toLocaleString()}
                      </span>
                    </div>
                    <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-400">
                      {JSON.stringify(log.metadata, null, 2)}
                    </pre>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
