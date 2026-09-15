import { NextResponse, type NextRequest } from "next/server";
import { requireBusiness } from "@halo/tenancy/auth";
import { getServerEnv } from "@halo/platform/env";
import { decodeOAuthState } from "@halo/platform/oauth-state";
import { getAdminClient } from "@halo/tenancy/supabase/admin";
import { timingSafeEqualStr } from "@halo/platform/crypto";
import { OAUTH_TOKEN_URLS } from "@halo/providers/calendar/token-source";
import { logger } from "@halo/platform/logger";
import {
  NONCE_COOKIE,
  googleRedirectUri,
  settingsRedirect,
  stateSecret,
  type CalendarConnectError,
} from "../shared";

export const dynamic = "force-dynamic";

const log = logger.child({ route: "oauth.google-calendar.callback" });

/**
 * GET /api/oauth/google-calendar/callback
 * Google redirects here after consent. Verifies the signed state against the
 * nonce cookie and the signed-in user's business, exchanges the code for
 * tokens, and stores them as the business-level calendar connection the
 * scheduling engine already reads (staff-level connections can be layered on
 * later). Every failure lands back on settings with an error code — the
 * visitor-facing booking flow never depends on this route.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const env = getServerEnv();

  const done = (result: { connected: true } | { error: CalendarConnectError }) => {
    const response = NextResponse.redirect(settingsRedirect(env, result));
    response.cookies.delete(NONCE_COOKIE);
    return response;
  };

  if (request.nextUrl.searchParams.get("error")) return done({ error: "denied" });

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const cookieNonce = request.cookies.get(NONCE_COOKIE)?.value ?? "";
  if (!code || !state || !cookieNonce) return done({ error: "invalid_state" });

  const payload = decodeOAuthState(state, stateSecret());
  if (!payload || !timingSafeEqualStr(payload.nonce, cookieNonce)) {
    return done({ error: "invalid_state" });
  }

  // The callback must land in the same signed-in business that started it.
  const { businessId, role } = await requireBusiness();
  if (businessId !== payload.businessId || role === "member") {
    return done({ error: "invalid_state" });
  }

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return done({ error: "not_configured" });
  }

  let tokens: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    const response = await fetch(OAUTH_TOKEN_URLS.google, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(env),
      }),
    });
    if (!response.ok) {
      log.error("google token exchange failed", {
        status: response.status,
        body: (await response.text().catch(() => "")).slice(0, 300),
      });
      return done({ error: "exchange_failed" });
    }
    tokens = await response.json();
  } catch (error) {
    log.error("google token exchange errored", { error });
    return done({ error: "exchange_failed" });
  }

  // Without a refresh token the connection dies within the hour — treat it
  // as a failed connect rather than storing a time bomb.
  if (!tokens.access_token || !tokens.refresh_token) {
    log.error("google token exchange returned no refresh token");
    return done({ error: "exchange_failed" });
  }

  // Replace any previous business-level Google connection. (Delete + insert
  // because the unique index treats the null staff_id rows as distinct.)
  const db = getAdminClient();
  await db
    .from("calendar_connections")
    .delete()
    .eq("business_id", businessId)
    .eq("provider", "google")
    .is("staff_id", null);
  const { error } = await db.from("calendar_connections").insert({
    business_id: businessId,
    staff_id: null,
    provider: "google",
    calendar_ref: "primary",
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
  });
  if (error) {
    log.error("calendar connection insert failed", { error: error.message });
    return done({ error: "exchange_failed" });
  }

  log.info("google calendar connected", { businessId });
  return done({ connected: true });
}
