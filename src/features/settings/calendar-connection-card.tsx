import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormSuccess } from "@/components/ui/form-feedback";
import { disconnectGoogleCalendar } from "./actions";
import type { CalendarConnectError } from "@/app/api/oauth/google-calendar/shared";

const ERROR_MESSAGES: Record<CalendarConnectError, string> = {
  not_configured:
    "Google Calendar isn't configured on this deployment yet — follow the setup steps below.",
  forbidden: "Only workspace admins can connect a calendar.",
  denied: "Google access was declined — nothing was connected.",
  invalid_state: "That connection attempt expired or didn't match — please try again.",
  exchange_failed: "Google didn't complete the connection — please try again.",
};

interface Props {
  connected: boolean;
  connectedAt: string | null;
  readOnly: boolean;
  /** Whether GOOGLE_CLIENT_ID/SECRET are set on this deployment. */
  configured: boolean;
  /** Exact callback URL to register in Google Cloud Console. */
  redirectUri: string;
  /** OAuth flow outcome from the redirect back to settings, if any. */
  flowResult?: { connected: boolean; error?: string };
}

/** Step-by-step operator setup shown instead of a dead-end error. */
function SetupWizard({ redirectUri }: { redirectUri: string }) {
  const steps: Array<{ title: string; body: React.ReactNode }> = [
    {
      title: "Create a Google OAuth client",
      body: (
        <>
          In the{" "}
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-indigo-600 underline dark:text-indigo-400"
          >
            Google Cloud Console → APIs &amp; Services → Credentials
          </a>
          , create an <strong>OAuth 2.0 Client ID</strong> of type{" "}
          <strong>Web application</strong>.
        </>
      ),
    },
    {
      title: "Register the redirect URI",
      body: (
        <>
          Add this exact URL as an authorized redirect URI:
          <code className="mt-1 block overflow-x-auto rounded bg-slate-100 px-2 py-1.5 font-mono text-xs text-slate-800 select-all dark:bg-slate-800 dark:text-slate-200">
            {redirectUri}
          </code>
        </>
      ),
    },
    {
      title: "Enable the Google Calendar API",
      body: (
        <>
          On the same Google Cloud project, enable the <strong>Google Calendar API</strong>{" "}
          (APIs &amp; Services → Library).
        </>
      ),
    },
    {
      title: "Set the environment variables",
      body: (
        <>
          Add the client credentials to this deployment and redeploy:
          <code className="mt-1 block overflow-x-auto rounded bg-slate-100 px-2 py-1.5 font-mono text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-200">
            GOOGLE_CLIENT_ID=…{"\n"}GOOGLE_CLIENT_SECRET=…
          </code>
        </>
      ),
    },
  ];

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700">
      <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          One-time setup required
        </p>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          This deployment doesn&apos;t have Google OAuth credentials yet. Complete these steps
          once, then this card becomes a Connect button. Bookings keep working on the built-in
          calendar in the meantime.
        </p>
      </div>
      <ol className="space-y-4 px-4 py-4">
        {steps.map((step, index) => (
          <li key={step.title} className="flex gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-[11px] font-bold text-white">
              {index + 1}
            </span>
            <div className="min-w-0 text-sm text-slate-600 dark:text-slate-300">
              <p className="font-medium text-slate-900 dark:text-slate-100">{step.title}</p>
              <div className="mt-0.5">{step.body}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Server component: shows whether the receptionist can see the business's
 * real Google Calendar, and lets an admin connect or disconnect it. The
 * connect button is a plain link — the OAuth flow is browser navigation.
 */
export function CalendarConnectionCard({
  connected,
  connectedAt,
  readOnly,
  configured,
  redirectUri,
  flowResult,
}: Props) {
  const errorMessage =
    flowResult?.error && flowResult.error in ERROR_MESSAGES
      ? ERROR_MESSAGES[flowResult.error as CalendarConnectError]
      : flowResult?.error
        ? ERROR_MESSAGES.exchange_failed
        : null;

  return (
    <Card>
      <CardHeader
        title="Google Calendar"
        description="Connect your calendar so the receptionist checks real availability and books appointments straight onto it. Without a connection, bookings still work using the built-in calendar."
      />
      <CardBody className="space-y-4">
        <FormSuccess message={flowResult?.connected ? "Google Calendar connected." : null} />
        <FormError message={errorMessage} />

        {connected ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                <span className="mr-2 inline-block h-2 w-2 rounded-full bg-emerald-500 align-middle" />
                Connected — bookings sync to your primary calendar
              </p>
              {connectedAt ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Connected on {new Date(connectedAt).toLocaleDateString()}
                </p>
              ) : null}
            </div>
            {!readOnly && (
              <form action={disconnectGoogleCalendar}>
                <Button type="submit" variant="secondary">
                  Disconnect
                </Button>
              </form>
            )}
          </div>
        ) : readOnly ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Not connected. Ask a workspace admin to connect it.
          </p>
        ) : !configured ? (
          <SetupWizard redirectUri={redirectUri} />
        ) : (
          <a
            href="/api/oauth/google-calendar/start"
            className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
          >
            Connect Google Calendar
          </a>
        )}
      </CardBody>
    </Card>
  );
}
