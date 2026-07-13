import type { MessagingProvider } from "@/core/ports/messaging-provider";
import { getServerEnv } from "@/lib/env";
import { LogMessagingProvider } from "./log-messaging-provider";

let cached: MessagingProvider | null = null;

/**
 * Messaging provider selection is pure configuration, mirroring the LLM
 * factory. "log" ships today; SMS (Twilio), WhatsApp (Cloud API) and email
 * gateways slot in as new cases here — the booking and reminder engines
 * depend only on the MessagingProvider port.
 */
export function getMessagingProvider(): MessagingProvider {
  if (cached) return cached;
  const env = getServerEnv();

  switch (env.MESSAGING_PROVIDER) {
    case "log":
      cached = new LogMessagingProvider();
      break;
    // case "twilio":   → TwilioMessagingProvider (sms + whatsapp)
    // case "resend":   → ResendMessagingProvider (email)
  }
  return cached;
}

/** Test helper. */
export function resetMessagingProviderForTests(): void {
  cached = null;
}
