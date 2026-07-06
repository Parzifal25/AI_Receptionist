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
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PROVIDER_ERROR: 502,
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
  static unauthorized(message = "Authentication required"): AppError {
    return new AppError("UNAUTHORIZED", message);
  }
  static forbidden(message = "Access denied"): AppError {
    return new AppError("FORBIDDEN", message);
  }
  static notFound(resource: string): AppError {
    return new AppError("NOT_FOUND", `${resource} not found`);
  }
  static conflict(message: string): AppError {
    return new AppError("CONFLICT", message);
  }
  static rateLimited(message = "Too many requests"): AppError {
    return new AppError("RATE_LIMITED", message);
  }
  static provider(message: string): AppError {
    return new AppError("PROVIDER_ERROR", message);
  }
  static internal(message = "An unexpected error occurred"): AppError {
    return new AppError("INTERNAL_ERROR", message);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
