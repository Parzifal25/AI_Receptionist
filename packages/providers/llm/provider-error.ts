import { AppError } from "@halo/core/errors/app-error";

export interface ProviderErrorBody {
  error?: { code?: string | number; message?: string; metadata?: { limit_source?: string; reason?: string } };
}

/** Only allowlisted categories and numeric measurements leave the provider boundary. */
export function providerErrorDetails(status: number, body: ProviderErrorBody, headers?: Headers) {
  const message = body.error?.message ?? "";
  const code = body.error?.code;
  const category = status === 402 ? "billing_limit"
    : status === 429 ? "rate_limit"
    : status === 408 || status === 504 ? "timeout"
    : status === 401 ? "authentication"
    : status === 403 ? "permission_denied"
    : status === 413 ? "request_size"
    : status === 404 && (code === "model_not_found" || /model.*(?:not found|does not exist|unavailable)/i.test(message)) ? "model_unavailable"
    : status === 400 && (code === "model_decommissioned" || code === "model_not_found") ? "model_unavailable"
    : status === 503 ? "provider_unavailable"
    : status >= 500 ? "provider_5xx" : "bad_request";
  const retry = headers?.get("retry-after");
  const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : undefined;
  const dateMs = retry && seconds === undefined ? Date.parse(retry) : NaN;
  const bodySeconds = /try again in ([\d.]+)s/i.exec(message)?.[1];
  const retryAfterMs = seconds !== undefined ? Math.ceil(seconds * 1000)
    : Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now())
    : bodySeconds ? Math.ceil(Number(bodySeconds) * 1000) : undefined;
  const source = body.error?.metadata?.limit_source;
  const reason = body.error?.metadata?.reason;
  return {
    category, status,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(["openrouter_credits", "openrouter_key_limit", "openrouter_in_flight_budget"].includes(source ?? "") ? { limitSource: source } : {}),
    ...(["weight_exceeds_budget", "in_flight_budget_exhausted"].includes(reason ?? "") ? { limitReason: reason } : {}),
    ...(category === "rate_limit" ? {
      rateLimitKind: /tokens per minute|\bTPM\b/i.test(message) ? "tokens_per_minute"
        : /tokens per day|\bTPD\b/i.test(message) ? "tokens_per_day"
        : /requests per minute|\bRPM\b/i.test(message) ? "requests_per_minute"
        : /requests per day|\bRPD\b/i.test(message) ? "requests_per_day" : "unspecified",
    } : {}),
  };
}

export function providerResponseError(status: number, body: ProviderErrorBody, headers?: Headers): AppError {
  return AppError.provider("AI service returned an error", providerErrorDetails(status, body, headers));
}
