import type { Metadata } from "next";
import Link from "next/link";
import { requireBusiness } from "@/lib/auth";
import { toLifecyclePatch } from "@/core/services/lifecycle/lifecycle-settings";
import { SchedulingRepository } from "@/core/services/scheduling/scheduling-repository";
import { LifecycleSettingsForm } from "@/features/lifecycle/lifecycle-settings-form";

export const metadata: Metadata = { title: "Customer lifecycle — AI Receptionist" };

/**
 * Editor for everything the lifecycle layer says to a customer. Reads
 * through the scheduling repository (service role, tenant-scoped here) so
 * the defaults for a business that has never configured scheduling are the
 * same ones the booking engine applies.
 */
export default async function LifecycleSettingsPage() {
  const { businessId, role } = await requireBusiness();
  const settings = await new SchedulingRepository().getSettings(businessId);

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <Link
          href="/dashboard/settings"
          className="text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
        >
          ← Settings
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">
          Customer lifecycle
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Confirmations, reminders, intake, and follow-up — everything that happens before and
          after an appointment.
        </p>
      </div>
      <LifecycleSettingsForm settings={toLifecyclePatch(settings)} readOnly={role === "member"} />
    </div>
  );
}
