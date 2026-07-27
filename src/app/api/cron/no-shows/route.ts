import { NextResponse, type NextRequest } from "next/server";
import { AppError } from "@/core/errors/app-error";
import { NoShowSweepService } from "@/core/services/lifecycle/no-show-sweep";
import { fail, withErrorHandling } from "@/lib/api/respond";
import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { timingSafeEqualStr } from "@/lib/crypto";

export const dynamic = "force-dynamic";

const log = logger.child({ route: "cron.no-shows" });

/**
 * GET /api/cron/no-shows
 * Closes out appointments nobody ever showed up for, for the businesses
 * that opted in (Settings → Customer lifecycle). Each sweep emits
 * `appointment.no_show`, which is what drives the recovery journey without
 * any staff input. Runs every 15 minutes; a re-run is harmless because
 * swept appointments are terminal and drop out of the candidate query.
 */
export const GET = withErrorHandling("cron.no-shows", async (request: NextRequest) => {
  const env = getServerEnv();
  if (!env.CRON_SECRET) {
    log.error("no-show cron hit but CRON_SECRET is not configured");
    return fail(AppError.internal("No-show sweep is not configured"));
  }

  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!timingSafeEqualStr(provided, env.CRON_SECRET)) {
    return fail(AppError.unauthorized());
  }

  const result = await new NoShowSweepService().sweep();
  log.info("no-show sweep complete", result);

  return NextResponse.json({ data: result });
});
