/**
 * Sliding-window in-memory rate limiter. Suitable for a single Node process;
 * the interface is deliberately async so a Redis/Upstash implementation can
 * replace it for multi-instance deployments without changing call sites.
 */

export interface RateLimiter {
  /** Returns true when the request is allowed. */
  check(key: string): Promise<RateLimitResult>;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Epoch millis when the oldest counted request leaves the window. */
  resetAt: number;
}

interface Bucket {
  timestamps: number[];
}

export function createMemoryRateLimiter(options: {
  limit: number;
  windowMs: number;
}): RateLimiter {
  const buckets = new Map<string, Bucket>();
  const { limit, windowMs } = options;

  // Periodically drop idle buckets so long-lived processes don't leak.
  let lastSweep = Date.now();
  const sweep = (now: number) => {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, bucket] of buckets) {
      if (bucket.timestamps.length === 0 || now - bucket.timestamps[bucket.timestamps.length - 1] > windowMs) {
        buckets.delete(key);
      }
    }
  };

  return {
    async check(key: string): Promise<RateLimitResult> {
      const now = Date.now();
      sweep(now);

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { timestamps: [] };
        buckets.set(key, bucket);
      }

      const windowStart = now - windowMs;
      bucket.timestamps = bucket.timestamps.filter((t) => t > windowStart);

      if (bucket.timestamps.length >= limit) {
        return {
          allowed: false,
          remaining: 0,
          resetAt: bucket.timestamps[0] + windowMs,
        };
      }

      bucket.timestamps.push(now);
      return {
        allowed: true,
        remaining: limit - bucket.timestamps.length,
        resetAt: now + windowMs,
      };
    },
  };
}

/** Shared limiters for the public widget API. */
export const widgetMessageLimiter = createMemoryRateLimiter({
  limit: 20,
  windowMs: 60_000,
});

export const widgetSessionLimiter = createMemoryRateLimiter({
  limit: 10,
  windowMs: 60_000,
});

export const widgetConfigLimiter = createMemoryRateLimiter({
  limit: 60,
  windowMs: 60_000,
});

/** Public appointment self-service (manage/feedback/intake) endpoints. */
export const appointmentManageLimiter = createMemoryRateLimiter({
  limit: 30,
  windowMs: 60_000,
});
