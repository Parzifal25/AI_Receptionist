/**
 * Application error taxonomy. Every error thrown from services carries a
 * machine-readable code and an HTTP status so API handlers can map them
 * without switch statements at every call site.
 */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PROVIDER_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PROVIDER_ERROR: 502,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Safe to serialize to clients. Never include secrets or internals. */
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError("VALIDATION_ERROR", message, details);
  }
  static unauthorized(message = "Authentication required", details?: unknown): AppError {
    return new AppError("UNAUTHORIZED", message, details);
  }
  static forbidden(message = "Access denied", details?: unknown): AppError {
    return new AppError("FORBIDDEN", message, details);
  }
  /**
   * `resource` is a noun ("Conversation", "Agent"); the message becomes
   * "<resource> not found". `details.reason` may carry a machine-readable
   * classification (see agent-resolver.ts) so callers never string-match.
   */
  static notFound(resource: string, details?: unknown): AppError {
    return new AppError("NOT_FOUND", `${resource} not found`, details);
  }
  static conflict(message: string, details?: unknown): AppError {
    return new AppError("CONFLICT", message, details);
  }
  static rateLimited(message = "Too many requests", details?: unknown): AppError {
    return new AppError("RATE_LIMITED", message, details);
  }
  static provider(message: string, details?: unknown): AppError {
    return new AppError("PROVIDER_ERROR", message, details);
  }
  static serviceUnavailable(message = "Service temporarily unavailable", details?: unknown): AppError {
    return new AppError("SERVICE_UNAVAILABLE", message, details);
  }
  static internal(message = "An unexpected error occurred", details?: unknown): AppError {
    return new AppError("INTERNAL_ERROR", message, details);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
