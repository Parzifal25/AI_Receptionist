import "server-only";
import { getServerEnv, type ServerEnv } from "@halo/platform/env";

/**
 * Shared pieces of the Google Calendar connect flow (start + callback
 * routes). The flow is browser-navigated from the dashboard, so failures
 * redirect back to settings with a readable error code instead of JSON.
 */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** freeBusy for availability + event CRUD for bookings — nothing broader. */
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
].join(" ");

/** CSRF nonce cookie pairing the callback with the browser that started. */
export const NONCE_COOKIE = "ar_gcal_oauth_nonce";

export type CalendarConnectError =
  | "not_configured"
  | "forbidden"
  | "denied"
  | "invalid_state"
  | "exchange_failed";

export function googleRedirectUri(env: ServerEnv): string {
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/api/oauth/google-calendar/callback`;
}

/** State/nonce signing secret — reuses the one secret every deploy has. */
export function stateSecret(): string {
  return getServerEnv().SUPABASE_SERVICE_ROLE_KEY;
}

export function settingsRedirect(env: ServerEnv, result: { connected: true } | { error: CalendarConnectError }): string {
  const query = "connected" in result ? "calendar=connected" : `calendar_error=${result.error}`;
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/dashboard/settings?${query}`;
}
