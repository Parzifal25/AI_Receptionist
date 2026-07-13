import { NextResponse, type NextRequest } from "next/server";
import { AppError } from "@/core/errors/app-error";
import { ReminderService } from "@/core/services/scheduling/reminder-service";
import { fail, withErrorHandling } from "@/lib/api/respond";
import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { timingSafeEqualStr } from "@/lib/crypto";

export const dynamic = "force-dynamic";

const log = logger.child({ route: "cron.reminders" });

/**
 * GET /api/cron/reminders
 * Delivers due appointment reminders. Runs every few minutes on Vercel Cron;
 * SKIP LOCKED claiming makes overlapping runs safe. Authorized by the same
 * shared secret as the other scheduled jobs.
 */
export const GET = withErrorHandling("cron.reminders", async (request: NextRequest) => {
  const env = getServerEnv();
  if (!env.CRON_SECRET) {
    log.error("reminders cron hit but CRON_SECRET is not configured");
    return fail(AppError.internal("Reminder job is not configured"));
  }

  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!timingSafeEqualStr(provided, env.CRON_SECRET)) {
    return fail(AppError.unauthorized());
  }

  const result = await new ReminderService().processDue();
  log.info("reminder run complete", result);

  return NextResponse.json({ data: result });
});
