import { NextResponse, type NextRequest } from "next/server";
import { AppError } from "@/core/errors/app-error";
import { getLLMProvider } from "@/providers/llm/factory";
import { clientIp, fail, withErrorHandling } from "@/lib/api/respond";
import { createMemoryRateLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Deep probes make an outbound LLM call, so they're rate limited to stop an
// unauthenticated caller from amplifying traffic to the AI provider.
const deepProbeLimiter = createMemoryRateLimiter({ limit: 6, windowMs: 60_000 });

/**
 * GET /api/health
 *   default → cheap liveness (the process is up). Ideal for load-balancer
 *             and uptime pings; makes no outbound calls.
 *   ?deep=1 → readiness: also probes the LLM provider. Rate limited.
 */
export const GET = withErrorHandling("health", async (request: NextRequest) => {
  const deep = request.nextUrl.searchParams.get("deep") === "1";

  if (!deep) {
    return NextResponse.json({
      data: { status: "ok", time: new Date().toISOString() },
    });
  }

  const rate = await deepProbeLimiter.check(`health:${clientIp(request)}`);
  if (!rate.allowed) return fail(AppError.rateLimited());

  const llm = getLLMProvider();
  const llmHealthy = await llm.isHealthy();

  return NextResponse.json(
    {
      data: {
        status: llmHealthy ? "ok" : "degraded",
        llm: { provider: llm.name, healthy: llmHealthy },
        time: new Date().toISOString(),
      },
    },
    { status: llmHealthy ? 200 : 503 },
  );
});
