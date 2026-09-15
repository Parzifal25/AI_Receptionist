/**
 * Small retry helper for calls to flaky external services (calendar APIs,
 * messaging gateways). Exponential backoff with jitter; retries only errors
 * the predicate deems transient (default: everything).
 */
export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  /** Return false to fail fast (e.g. on 4xx responses). */
  isRetryable?: (error: unknown) => boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 3, baseDelayMs = 300, isRetryable = () => true, sleep = defaultSleep } = options;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) throw error;
      const delay = baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5);
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Error carrying an HTTP status, thrown by provider adapters. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Retry 429s and 5xx; fail fast on other HTTP errors. */
export function isTransientHttpError(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 429 || error.status >= 500;
  return true; // network-level failures are retryable
}
