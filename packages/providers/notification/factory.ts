import type { NotificationProvider } from "@halo/ports/notification-provider";
import { getServerEnv } from "@halo/platform/env";
import { LogNotificationProvider } from "./log-notification-provider";
import { ResendNotificationProvider } from "./resend-notification-provider";

let cached: NotificationProvider | null = null;

/**
 * Resolves the lead-notification provider from configuration. Resend is
 * selected whenever MESSAGING_PROVIDER includes "resend" — i.e. both
 * "resend" and "resend+whatsapp" — so composite email+WhatsApp deployments
 * no longer silently fall back to log-only lead alerts (plan P0.1#8).
 */
export function getNotificationProvider(): NotificationProvider {
  if (cached) return cached;
  const env = getServerEnv();

  if (env.MESSAGING_PROVIDER.includes("resend")) {
    cached = new ResendNotificationProvider();
  } else {
    cached = new LogNotificationProvider();
  }
  return cached;
}

/** Test helper. */
export function resetNotificationProviderForTests(): void {
  cached = null;
}
