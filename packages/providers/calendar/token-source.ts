import { HttpError } from "@halo/platform/retry";

/**
 * Supplies a valid OAuth access token for a calendar connection, refreshing
 * transparently when expired. Adapters depend on this function type, not on
 * where tokens live — the repository persists rotated tokens via `onRotate`.
 */
export type TokenSource = () => Promise<string>;

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** UTC ISO expiry of the access token; empty means unknown/expired. */
  expiresAt: string;
}

interface RefreshEndpoint {
  url: string;
  clientId: string;
  clientSecret: string;
}

/** Refresh 60s early so a token never expires mid-request. */
const EXPIRY_SLACK_MS = 60_000;

async function refreshOAuthToken(
  endpoint: RefreshEndpoint,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: string; refreshToken?: string }> {
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: endpoint.clientId,
      client_secret: endpoint.clientSecret,
    }),
  });
  if (!response.ok) {
    throw new HttpError(response.status, `OAuth token refresh failed (${response.status})`);
  }
  const data = (await response.json()) as {
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
  };
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
    refreshToken: data.refresh_token,
  };
}

export const OAUTH_TOKEN_URLS = {
  google: "https://oauth2.googleapis.com/token",
  outlook: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
} as const;

/**
 * Builds a caching, auto-refreshing token source from stored connection
 * tokens. `onRotate` persists new tokens so refreshes survive restarts.
 */
export function createOAuthTokenSource(params: {
  tokens: OAuthTokens;
  endpoint: RefreshEndpoint;
  onRotate: (tokens: OAuthTokens) => Promise<void>;
}): TokenSource {
  let current = { ...params.tokens };
  let refreshing: Promise<string> | null = null;

  return async () => {
    const fresh =
      current.accessToken &&
      current.expiresAt &&
      Date.parse(current.expiresAt) - EXPIRY_SLACK_MS > Date.now();
    if (fresh) return current.accessToken;

    // Single-flight: concurrent callers share one refresh request.
    refreshing ??= (async () => {
      try {
        const next = await refreshOAuthToken(params.endpoint, current.refreshToken);
        current = {
          accessToken: next.accessToken,
          expiresAt: next.expiresAt,
          refreshToken: next.refreshToken ?? current.refreshToken,
        };
        await params.onRotate(current).catch(() => {});
        return current.accessToken;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };
}

/** Shared JSON fetch for calendar adapters — throws HttpError on failure. */
export async function authedJsonFetch<T>(
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new HttpError(response.status, `${url} → ${response.status}: ${body.slice(0, 200)}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json().catch(() => undefined)) as T;
}
