import { NextResponse } from "next/server";
import { getLLMProvider } from "@/providers/llm/factory";
import { withErrorHandling } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — liveness + dependency probe for uptime monitoring.
 */
export const GET = withErrorHandling("health", async () => {
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
