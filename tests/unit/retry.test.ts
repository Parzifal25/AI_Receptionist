import { describe, expect, it, vi } from "vitest";
import { HttpError, isTransientHttpError, withRetry } from "@/lib/retry";

const noSleep = async () => {};

describe("withRetry", () => {
  it("returns on first success without retrying", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await withRetry(fn, { sleep: noSleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures up to the attempt budget", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new HttpError(503, "unavailable");
      return "recovered";
    });
    expect(await withRetry(fn, { attempts: 3, sleep: noSleep })).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("fails fast on non-retryable errors", async () => {
    const fn = vi.fn(async () => {
      throw new HttpError(404, "not found");
    });
    await expect(
      withRetry(fn, { attempts: 3, isRetryable: isTransientHttpError, sleep: noSleep }),
    ).rejects.toThrow("not found");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws the last error when attempts are exhausted", async () => {
    const fn = vi.fn(async () => {
      throw new HttpError(500, "boom");
    });
    await expect(
      withRetry(fn, { attempts: 2, isRetryable: isTransientHttpError, sleep: noSleep }),
    ).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("isTransientHttpError", () => {
  it("classifies HTTP statuses", () => {
    expect(isTransientHttpError(new HttpError(429, ""))).toBe(true);
    expect(isTransientHttpError(new HttpError(503, ""))).toBe(true);
    expect(isTransientHttpError(new HttpError(400, ""))).toBe(false);
    expect(isTransientHttpError(new HttpError(401, ""))).toBe(false);
    expect(isTransientHttpError(new Error("socket hang up"))).toBe(true);
  });
});
