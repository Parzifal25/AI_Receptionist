import type { CalendarProviderKind } from "@halo/core/domain/scheduling";
import type { CalendarProvider } from "@halo/ports/calendar-provider";
import { getServerEnv } from "@halo/platform/env";
import { CalDavCalendarProvider } from "./caldav-calendar-provider";
import { GoogleCalendarProvider } from "./google-calendar-provider";
import { InternalCalendarProvider } from "./internal-calendar-provider";
import { OutlookCalendarProvider } from "./outlook-calendar-provider";
import { createOAuthTokenSource, OAUTH_TOKEN_URLS, type OAuthTokens } from "./token-source";

/** A tenant's stored calendar credentials, decoupled from the DB row shape. */
export interface CalendarConnection {
  provider: CalendarProviderKind;
  calendarRef: string;
  oauth?: OAuthTokens;
  basicAuth?: { username: string; password: string };
  /** Persists rotated OAuth tokens. */
  onTokenRotate?: (tokens: OAuthTokens) => Promise<void>;
}

/**
 * Builds the calendar adapter for a connection. Business logic never touches
 * a concrete provider class — connecting Google, Outlook or CalDAV is data.
 */
export function createCalendarProvider(connection: CalendarConnection): CalendarProvider {
  const env = getServerEnv();

  switch (connection.provider) {
    case "internal":
      return new InternalCalendarProvider();

    case "google": {
      if (!connection.oauth) throw new Error("Google calendar connection is missing OAuth tokens");
      return new GoogleCalendarProvider(
        createOAuthTokenSource({
          tokens: connection.oauth,
          endpoint: {
            url: OAUTH_TOKEN_URLS.google,
            clientId: env.GOOGLE_CLIENT_ID ?? "",
            clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
          },
          onRotate: connection.onTokenRotate ?? (async () => {}),
        }),
      );
    }

    case "outlook": {
      if (!connection.oauth) throw new Error("Outlook calendar connection is missing OAuth tokens");
      return new OutlookCalendarProvider(
        createOAuthTokenSource({
          tokens: connection.oauth,
          endpoint: {
            url: OAUTH_TOKEN_URLS.outlook,
            clientId: env.MICROSOFT_CLIENT_ID ?? "",
            clientSecret: env.MICROSOFT_CLIENT_SECRET ?? "",
          },
          onRotate: connection.onTokenRotate ?? (async () => {}),
        }),
      );
    }

    case "caldav": {
      if (!connection.basicAuth) throw new Error("CalDAV connection is missing credentials");
      return new CalDavCalendarProvider(
        connection.basicAuth.username,
        connection.basicAuth.password,
      );
    }
  }
}
