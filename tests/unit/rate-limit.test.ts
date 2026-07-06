import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRateLimiter } from "@/lib/rate-limit";

describe("createMemoryRateLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("allows up to the limit and then rejects", async () => {
    const limiter = createMemoryRateLimiter({ limit: 3, windowMs: 60_000 });
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(false);
  });

  it("tracks keys independently", async () => {
    const limiter = createMemoryRateLimiter({ limit: 1, windowMs: 60_000 });
    expect((await limiter.check("a")).allowed).toBe(true);
    expect((await limiter.check("b")).allowed).toBe(true);
    expect((await limiter.check("a")).allowed).toBe(false);
  });

  it("frees capacity when the window slides", async () => {
    const limiter = createMemoryRateLimiter({ limit: 2, windowMs: 60_000 });
    await limiter.check("k");
    await limiter.check("k");
    expect((await limiter.check("k")).allowed).toBe(false);

    vi.advanceTimersByTime(61_000);
    expect((await limiter.check("k")).allowed).toBe(true);
  });

  it("reports remaining and reset time", async () => {
    const limiter = createMemoryRateLimiter({ limit: 2, windowMs: 60_000 });
    const first = await limiter.check("k");
    expect(first.remaining).toBe(1);
    await limiter.check("k");
    const rejected = await limiter.check("k");
    expect(rejected.remaining).toBe(0);
    expect(rejected.resetAt).toBeGreaterThan(Date.now());
  });
});
