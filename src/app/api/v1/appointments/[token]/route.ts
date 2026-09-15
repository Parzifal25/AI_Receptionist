import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@halo/core/errors/app-error";
import { AppointmentManageService } from "@halo/lifecycle/manage-service";
import { clientIp, fail, withErrorHandling } from "@/lib/api/respond";
import { appointmentManageLimiter } from "@halo/platform/rate-limit";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

const tokenSchema = z.string().uuid();

async function guard(request: NextRequest, context: Context): Promise<string> {
  const rate = await appointmentManageLimiter.check(`manage:${clientIp(request)}`);
  if (!rate.allowed) throw AppError.rateLimited();
  const { token } = await context.params;
  const parsed = tokenSchema.safeParse(token);
  // A malformed token gets the same 404 as an unknown one — no oracle.
  if (!parsed.success) throw AppError.notFound("Appointment");
  return parsed.data;
}

/**
 * GET /api/v1/appointments/:token
 * Everything the self-service page shows: the appointment, business
 * contact facts, prep/directions content, the intake form, and (when the
 * appointment is still live) slots it can move to.
 */
export const GET = withErrorHandling(
  "appointments.manage.get",
  async (request: NextRequest, context: Context) => {
    const token = await guard(request, context);
    const service = new AppointmentManageService();
    const manage = await service.getContext(token);
    if (!manage) return fail(AppError.notFound("Appointment"));

    const slots = manage.isLive ? await service.listRescheduleSlots(token) : [];
    const { appointment, business, settings } = manage;
    return NextResponse.json({
      data: {
        appointment: {
          serviceName: appointment.serviceName,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
          timezone: appointment.timezone,
          status: appointment.status,
          visitorName: appointment.visitorName,
        },
        business: { name: business.name, phone: business.phone },
        locationAddress: settings.locationAddress || business.address,
        prepInstructions: settings.prepInstructions,
        intakeForm: settings.intakeForm,
        intakeSubmitted: manage.intakeAnswers !== null,
        feedbackSubmitted: manage.feedback !== null,
        isLive: manage.isLive,
        rescheduleSlots: slots,
      },
    });
  },
);

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel"), reason: z.string().max(500).optional() }),
  z.object({
    action: z.literal("reschedule"),
    startsAt: z.string().min(1),
    staffId: z.string().min(1),
  }),
  z.object({ action: z.literal("check_in") }),
  z.object({ action: z.literal("running_late") }),
]);

/** POST /api/v1/appointments/:token — cancel / reschedule / day-of updates. */
export const POST = withErrorHandling(
  "appointments.manage.act",
  async (request: NextRequest, context: Context) => {
    const token = await guard(request, context);
    const body = actionSchema.parse(await request.json());
    const service = new AppointmentManageService();

    switch (body.action) {
      case "cancel":
        await service.cancel(token, body.reason);
        return NextResponse.json({ data: { status: "cancelled" } });
      case "reschedule": {
        const result = await service.reschedule(token, body.startsAt, body.staffId);
        if (!result.ok) {
          return fail(
            AppError.conflict(
              result.reason === "slot_taken"
                ? "That time was just taken — pick another"
                : result.message,
            ),
          );
        }
        return NextResponse.json({
          data: { status: result.appointment.status, startsAt: result.appointment.startsAt },
        });
      }
      case "check_in": {
        const updated = await service.checkIn(token);
        return NextResponse.json({ data: { status: updated.status } });
      }
      case "running_late": {
        const updated = await service.runningLate(token);
        return NextResponse.json({ data: { status: updated.status } });
      }
    }
  },
);
