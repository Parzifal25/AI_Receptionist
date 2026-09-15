import type { Metadata } from "next";
import { requireBusiness } from "@halo/tenancy/auth";
import { SupabaseWorkflowStore } from "@halo/workflows/supabase-workflow-store";
import { WORKFLOW_TEMPLATES } from "@halo/workflows/templates";
import { AutomationsClient } from "./automations-client";

export const metadata: Metadata = { title: "Automations — AI Receptionist" };
export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  const { businessId, role } = await requireBusiness();
  const workflows = await new SupabaseWorkflowStore().listWorkflows(businessId);

  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Automations</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Visual workflows that react to your business events — bookings, completed visits,
          feedback — with messages, follow-ups, CRM updates, and back-office records.
        </p>
      </div>
      <AutomationsClient
        workflows={workflows}
        templates={WORKFLOW_TEMPLATES}
        canEdit={role !== "member"}
      />
    </div>
  );
}
