import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AppointmentManageService } from "@halo/lifecycle/manage-service";
import { directionsUrl } from "@halo/lifecycle/confirmation-content";
import { formatInTz } from "@halo/scheduling/timezone";
import { ManageActions } from "./manage-client";

export const metadata: Metadata = { title: "Your appointment" };
export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending confirmation",
  confirmed: "Confirmed",
  checked_in: "Checked in",
  running_late: "Running late",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "Missed",
};

/**
 * Public self-service page reached from confirmation/reminder links. The
 * token in the URL is the entire credential — nothing else identifies the
 * visitor — so the page renders only this appointment's own facts.
 */
export default async function ManageAppointmentPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!z.string().uuid().safeParse(token).success) notFound();

  const service = new AppointmentManageService();
  const manage = await service.getContext(token);
  if (!manage) notFound();

  const { appointment, business, settings } = manage;
  const slots = manage.isLive ? await service.listRescheduleSlots(token) : [];
  const address = settings.locationAddress || business.address;
  const maps = directionsUrl(address);

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10 dark:bg-slate-950">
      <div className="mx-auto max-w-xl space-y-6">
        <header>
          <p className="text-sm font-medium text-indigo-600 dark:text-indigo-400">{business.name}</p>
          <h1 className="mt-1 text-2xl font-bold text-slate-900 dark:text-white">
            {appointment.serviceName || "Your appointment"}
          </h1>
          <p className="mt-2 text-slate-600 dark:text-slate-300">
            {formatInTz(appointment.startsAt, appointment.timezone)}
          </p>
          <span className="mt-2 inline-block rounded-full bg-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
            {STATUS_LABELS[appointment.status] ?? appointment.status}
          </span>
        </header>

        {(address || settings.prepInstructions) && (
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            {address && (
              <div className="mb-3">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Where to go</h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{address}</p>
                {maps && (
                  <a
                    href={maps}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-block text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    Get directions →
                  </a>
                )}
              </div>
            )}
            {settings.prepInstructions && (
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">How to prepare</h2>
                <p className="mt-1 whitespace-pre-line text-sm text-slate-600 dark:text-slate-300">
                  {settings.prepInstructions}
                </p>
              </div>
            )}
          </section>
        )}

        <ManageActions
          token={token}
          status={appointment.status}
          isLive={manage.isLive}
          startsAt={appointment.startsAt}
          timezone={appointment.timezone}
          slots={slots}
          intakeForm={settings.intakeForm}
          intakeSubmitted={manage.intakeAnswers !== null}
          feedbackSubmitted={manage.feedback !== null}
          businessPhone={business.phone}
        />
      </div>
    </main>
  );
}
