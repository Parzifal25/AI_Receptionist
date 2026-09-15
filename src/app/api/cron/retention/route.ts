import { NextResponse, type NextRequest } from "next/server";
import { AppError } from "@halo/core/errors/app-error";
import { WidgetRepository } from "@/core/services/widget-repository";
import { fail, withErrorHandling } from "@/lib/api/respond";
import { getServerEnv } from "@halo/platform/env";
import { logger } from "@halo/platform/logger";
import { timingSafeEqualStr } from "@halo/platform/crypto";

export const dynamic = "force-dynamic";

const log = logger.child({ route: "cron.retention" });

/**
 * GET /api/cron/retention
 * Deletes conversational data past each tenant's retention window. Meant to
 * run on a schedule (Vercel Cron). Authorized by a shared secret — Vercel
 * Cron sends it as `Authorization: Bearer <CRON_SECRET>`.
 */
export const GET = withErrorHandling("cron.retention", async (request: NextRequest) => {
  const env = getServerEnv();
  if (!env.CRON_SECRET) {
    log.error("retention cron hit but CRON_SECRET is not configured");
    return fail(AppError.internal("Retention job is not configured"));
  }

  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!timingSafeEqualStr(provided, env.CRON_SECRET)) {
    return fail(AppError.unauthorized());
  }

  const result = await new WidgetRepository().purgeExpiredData();
  log.info("retention purge complete", result);

  return NextResponse.json({ data: result });
});
