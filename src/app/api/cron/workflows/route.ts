import { NextResponse, type NextRequest } from "next/server";
import { AppError } from "@halo/core/errors/app-error";
import { emitBusinessEvent, getWorkflowEngine } from "@halo/workflows/event-bus";
import { fail, withErrorHandling } from "@/lib/api/respond";
import { getServerEnv } from "@halo/platform/env";
import { logger } from "@halo/platform/logger";
import { timingSafeEqualStr } from "@halo/platform/crypto";

export const dynamic = "force-dynamic";

const log = logger.child({ route: "cron.workflows" });

/**
 * GET /api/cron/workflows
 * The workflow engine's heartbeat: fires due timers (scheduled triggers)
 * and retries failed runs whose backoff has elapsed. SKIP LOCKED claiming
 * makes overlapping executions safe.
 */
export const GET = withErrorHandling("cron.workflows", async (request: NextRequest) => {
  const env = getServerEnv();
  if (!env.CRON_SECRET) {
    log.error("workflows cron hit but CRON_SECRET is not configured");
    return fail(AppError.internal("Workflow job is not configured"));
  }

  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!timingSafeEqualStr(provided, env.CRON_SECRET)) {
    return fail(AppError.unauthorized());
  }

  const result = await getWorkflowEngine().processDue({
    emit: (event) =>
      emitBusinessEvent({
        businessId: event.businessId,
        type: event.type,
        correlationId: event.correlationId,
        payload: event.payload,
      }),
  });
  log.info("workflow run complete", result);

  return NextResponse.json({ data: result });
});
