import { NextResponse, type NextRequest } from "next/server";
import { AppError } from "@halo/core/errors/app-error";
import { getLLMProvider } from "@halo/providers/llm/factory";
import { clientIp, fail, withErrorHandling } from "@/lib/api/respond";
import { createMemoryRateLimiter } from "@halo/platform/rate-limit";
import { timingSafeEqualStr } from "@halo/platform/crypto";
import { getServerEnv } from "@halo/platform/env";
import { validateProductionReadiness } from "@/lib/startup-check";

export const dynamic = "force-dynamic";

// Deep probes make an outbound LLM call and a database round-trip, so they
// are authenticated AND rate limited.
const deepProbeLimiter = createMemoryRateLimiter({ limit: 6, windowMs: 60_000 });

/**
 * GET /api/health
 *   default → cheap liveness (the process is up). Ideal for load-balancer
 *             and uptime pings; makes no outbound calls and is public.
 *   ?deep=1 → readiness: also probes the LLM provider and the database.
 *             **Authenticated**: requires `Authorization: Bearer <CRON_SECRET>`
 *             so readiness internals (error strings naming env vars and
 *             infrastructure) never reach anonymous callers. Rate limited.
 */
export const GET = withErrorHandling("health", async (request: NextRequest) => {
  const deep = request.nextUrl.searchParams.get("deep") === "1";

  if (!deep) {
    return NextResponse.json({
      data: { status: "ok", time: new Date().toISOString() },
    });
  }

  // Fail closed: without a configured secret the deep probe is disabled —
  // the same rule the cron routes follow.
  const env = getServerEnv();
  const probeSecret = env.CRON_SECRET;
  if (!probeSecret) {
    return fail(AppError.forbidden("Deep health probe is disabled (no probe secret configured)"));
  }
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!timingSafeEqualStr(token, probeSecret)) {
    return fail(AppError.unauthorized("Valid probe secret required for deep health check"));
  }

  const rate = await deepProbeLimiter.check(`health:${clientIp(request)}`);
  if (!rate.allowed) return fail(AppError.rateLimited());

  const llm = getLLMProvider();
  const llmHealthy = await llm.isHealthy();
  const readiness = await validateProductionReadiness();

  const isOk = llmHealthy && readiness.ready;

  return NextResponse.json(
    {
      data: {
        status: isOk ? "ok" : "degraded",
        llm: { provider: llm.name, healthy: llmHealthy },
        database: { connected: readiness.ready && !readiness.errors.some(e => e.includes("Database")) },
        providers: readiness.providers,
        readiness: {
          ready: readiness.ready,
          errors: readiness.errors,
          warnings: readiness.warnings,
        },
        time: new Date().toISOString(),
      },
    },
    { status: isOk ? 200 : 503 },
  );
});
