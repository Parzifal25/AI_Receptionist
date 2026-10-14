import { observe, telemetryId, withTelemetryContext } from "@halo/platform/telemetry";
import { NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { AppError, isAppError } from "@halo/core/errors/app-error";
import { logger } from "@halo/platform/logger";

/**
 * Uniform API envelope:
 *   success → { data: ... }
 *   failure → { error: { code, message, details? } }
 */

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ data }, init);
}

export function fail(error: AppError, headers?: HeadersInit): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    },
    { status: error.status, headers },
  );
}

/**
 * Wraps a route handler with error mapping and request logging. Unknown
 * errors are logged with redacted context but returned to clients as an opaque
 * 500 — internals never leak.
 */
export function withErrorHandling<Args extends unknown[]>(
  routeName: string,
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  const mapped = async (...args: Args) => {
    const log = logger.child({ route: routeName });
    try {
      return await handler(...args);
    } catch (error) {
      // Next's navigation signals (redirect/notFound from shared auth
      // helpers like requireUser) are control flow, not failures. Swallowing
      // them turned an unauthenticated API call into an opaque 500 and hid
      // the real outcome; rethrow so Next completes the navigation.
      unstable_rethrow(error);
      if (isAppError(error)) {
        if (error.status >= 500) log.error("request failed", { code: error.code, error });
        else log.warn("request rejected", { code: error.code, message: error.message });
        return fail(error);
      }
      if (error instanceof ZodError) {
        return fail(
          AppError.validation("Invalid request", error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          }))),
        );
      }
      log.error("unhandled error", { error });
      return fail(AppError.internal());
    }
  };
  return (...args: Args) => withTelemetryContext(async () => {
    const started = performance.now();
    let status = 500;
    try {
      const response = await mapped(...args);
      status = response.status;
      response.headers.set("x-request-id", telemetryId()!);
      return response;
    } finally {
      observe("http.request", { component: "api", route: routeName.split(".")[0], operation: "request", status,
        outcome: status >= 500 ? "error" : status >= 400 ? "rejected" : "ok" }, performance.now() - started);
    }
  });
}

/** Extracts the caller IP for rate limiting, honoring proxy headers. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
