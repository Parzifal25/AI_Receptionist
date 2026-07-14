import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@/core/errors/app-error";
import { AppointmentManageService } from "@/core/services/lifecycle/manage-service";
import { clientIp, withErrorHandling } from "@/lib/api/respond";
import { appointmentManageLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  answers: z.record(z.string(), z.union([z.string(), z.boolean()])),
});

/** POST /api/v1/appointments/:token/intake — pre-visit intake form. */
export const POST = withErrorHandling(
  "appointments.intake",
  async (request: NextRequest, context: { params: Promise<{ token: string }> }) => {
    const rate = await appointmentManageLimiter.check(`manage:${clientIp(request)}`);
    if (!rate.allowed) throw AppError.rateLimited();

    const { token } = await context.params;
    if (!z.string().uuid().safeParse(token).success) throw AppError.notFound("Appointment");

    const { answers } = bodySchema.parse(await request.json());
    await new AppointmentManageService().submitIntake(token, answers);
    return NextResponse.json({ data: { received: true } });
  },
);
