import { NextResponse, type NextRequest } from "next/server";
import { AppError } from "@halo/core/errors/app-error";
import { emitBusinessEvent } from "@halo/workflows/event-bus";
import { fail, withErrorHandling } from "@/lib/api/respond";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { timingSafeEqualStr } from "@halo/platform/crypto";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;

/**
 * POST /api/hooks/:businessId
 * Inbound webhook trigger: external systems (Zapier, n8n, Make, custom
 * services) fire a tenant's "webhook.received" workflows. Authenticated by
 * the per-business secret in business_settings.workflow_webhook_secret,
 * sent as an `x-webhook-token` header (or `?token=` for platforms that
 * can't set headers). An empty secret means the trigger is disabled.
 */
export const POST = withErrorHandling(
  "hooks.trigger",
  async (request: NextRequest, context: { params: Promise<{ businessId: string }> }) => {
    const { businessId } = await context.params;

    const { data: settings } = await getAdminClient()
      .from("business_settings")
      .select("workflow_webhook_secret")
      .eq("business_id", businessId)
      .maybeSingle();

    const secret = settings?.workflow_webhook_secret ?? "";
    const provided =
      request.headers.get("x-webhook-token") ??
      new URL(request.url).searchParams.get("token") ??
      "";
    if (!secret || !timingSafeEqualStr(provided, secret)) {
      return fail(AppError.unauthorized());
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return fail(AppError.validation("Payload too large"));
    }
    let payload: Record<string, unknown> = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        payload =
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { body: parsed };
      } catch {
        return fail(AppError.validation("Body must be JSON"));
      }
    }

    await emitBusinessEvent({ businessId, type: "webhook.received", payload });
    return NextResponse.json({ data: { accepted: true } });
  },
);
