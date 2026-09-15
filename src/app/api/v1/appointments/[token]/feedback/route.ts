import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@halo/core/errors/app-error";
import { feedbackSchema } from "@halo/lifecycle/feedback-service";
import { AppointmentManageService } from "@halo/lifecycle/manage-service";
import { clientIp, withErrorHandling } from "@/lib/api/respond";
import { appointmentManageLimiter } from "@halo/platform/rate-limit";

export const dynamic = "force-dynamic";

/** POST /api/v1/appointments/:token/feedback — satisfaction survey. */
export const POST = withErrorHandling(
  "appointments.feedback",
  async (request: NextRequest, context: { params: Promise<{ token: string }> }) => {
    const rate = await appointmentManageLimiter.check(`manage:${clientIp(request)}`);
    if (!rate.allowed) throw AppError.rateLimited();

    const { token } = await context.params;
    if (!z.string().uuid().safeParse(token).success) throw AppError.notFound("Appointment");

    const input = feedbackSchema.parse(await request.json());
    await new AppointmentManageService().submitFeedback(token, input);
    return NextResponse.json({ data: { received: true } });
  },
);
