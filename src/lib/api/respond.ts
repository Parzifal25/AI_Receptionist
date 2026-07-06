import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError, isAppError } from "@/core/errors/app-error";
import { logger } from "@/lib/logger";

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
 * errors are logged with full detail but returned to clients as an opaque
 * 500 — internals never leak.
 */
export function withErrorHandling<Args extends unknown[]>(
  routeName: string,
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    const log = logger.child({ route: routeName });
    try {
      return await handler(...args);
    } catch (error) {
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
}

/** Extracts the caller IP for rate limiting, honoring proxy headers. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
