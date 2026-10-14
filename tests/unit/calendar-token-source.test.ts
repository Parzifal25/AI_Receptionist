import { afterEach, describe, expect, it, vi } from "vitest";
import { createOAuthTokenSource } from "@halo/providers/calendar/token-source";

const endpoint = { url: "https://oauth.test/token", clientId: "client", clientSecret: "secret" };

afterEach(() => vi.unstubAllGlobals());

describe("calendar OAuth token source", () => {
  it("returns a still-valid access token without refreshing", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const source = createOAuthTokenSource({
      tokens: { accessToken: "access", refreshToken: "refresh", expiresAt: new Date(Date.now() + 120_000).toISOString() },
      endpoint,
      onRotate: vi.fn(),
    });

    await expect(source()).resolves.toBe("access");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shares concurrent refreshes and persists rotated credentials before returning", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
    });
    vi.stubGlobal("fetch", fetch);
    const onRotate = vi.fn().mockResolvedValue(undefined);
    const source = createOAuthTokenSource({
      tokens: { accessToken: "old", refreshToken: "old-refresh", expiresAt: "" },
      endpoint,
      onRotate,
    });

    await expect(Promise.all([source(), source()])).resolves.toEqual(["new-access", "new-access"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onRotate).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    }));
  });

  it("fails the request and retries refresh if rotated credentials cannot be persisted", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "new-access", expires_in: 3600 }),
    });
    vi.stubGlobal("fetch", fetch);
    const onRotate = vi.fn().mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValue(undefined);
    const source = createOAuthTokenSource({
      tokens: { accessToken: "old", refreshToken: "refresh", expiresAt: "" },
      endpoint,
      onRotate,
    });

    await expect(source()).rejects.toThrow("database unavailable");
    await expect(source()).resolves.toBe("new-access");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onRotate).toHaveBeenCalledTimes(2);
  });
});
