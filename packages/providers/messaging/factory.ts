import type { MessagingProvider } from "@halo/ports/messaging-provider";
import { getServerEnv } from "@halo/platform/env";
import { LogMessagingProvider } from "./log-messaging-provider";
import { WhatsappMessagingProvider } from "./whatsapp-messaging-provider";
import { ResendMessagingProvider } from "./resend-messaging-provider";
import { CompositeMessagingProvider } from "./composite-messaging-provider";

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
    case "whatsapp":
      cached = new WhatsappMessagingProvider();
      break;
    case "resend":
      cached = new ResendMessagingProvider();
      break;
    case "resend+whatsapp":
      cached = new CompositeMessagingProvider([
        new ResendMessagingProvider(),
        new WhatsappMessagingProvider(),
      ]);
      break;
  }
  return cached;
}


/** Test helper. */
export function resetMessagingProviderForTests(): void {
  cached = null;
}
