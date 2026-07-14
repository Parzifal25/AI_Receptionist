import { NextResponse } from "next/server";
import { requireBusiness } from "@/lib/auth";
import { getServerEnv } from "@/lib/env";
import { createOAuthNonce, encodeOAuthState } from "@/lib/oauth-state";
import { logger } from "@/lib/logger";
import {
  GOOGLE_AUTH_URL,
  GOOGLE_CALENDAR_SCOPES,
  NONCE_COOKIE,
  googleRedirectUri,
  settingsRedirect,
  stateSecret,
} from "../shared";

export const dynamic = "force-dynamic";

const log = logger.child({ route: "oauth.google-calendar.start" });

/**
 * GET /api/oauth/google-calendar/start
 * Dashboard-initiated: sends a signed-in admin to Google's consent screen.
 * The signed state pins the callback to this business; the nonce cookie pins
 * it to this browser. `access_type=offline` + `prompt=consent` guarantee a
 * refresh token, which the booking engine needs to sync unattended.
 */
export async function GET(): Promise<NextResponse> {
  const env = getServerEnv();
  const { businessId, role } = await requireBusiness();

  if (role === "member") {
    return NextResponse.redirect(settingsRedirect(env, { error: "forbidden" }));
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    log.warn("google calendar connect attempted without GOOGLE_CLIENT_ID/SECRET");
    return NextResponse.redirect(settingsRedirect(env, { error: "not_configured" }));
  }

  const nonce = createOAuthNonce();
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", googleRedirectUri(env));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", encodeOAuthState({ businessId, nonce }, stateSecret()));

  const response = NextResponse.redirect(url);
  response.cookies.set(NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/api/oauth/google-calendar",
    maxAge: 600,
  });
  return response;
}
