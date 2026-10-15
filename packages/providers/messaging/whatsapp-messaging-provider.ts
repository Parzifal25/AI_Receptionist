import "server-only";
import { type MessageChannel, type MessagingProvider, type OutboundMessage } from "@halo/ports/messaging-provider";
import { AppError } from "@halo/core/errors/app-error";
import { logger } from "@halo/platform/logger";
import { HttpError, isTransientHttpError, withRetry } from "@halo/platform/retry";
import { getServerEnv } from "@halo/platform/env";

export class WhatsappMessagingProvider implements MessagingProvider {
  readonly name = "whatsapp";

  supports(channel: MessageChannel): boolean {
    return channel === "whatsapp";
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.supports(message.channel)) {
      throw AppError.internal(`WhatsappMessagingProvider does not support channel: ${message.channel}`);
    }

    const env = getServerEnv();
    if (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_ACCESS_TOKEN) {
      throw AppError.internal("WhatsApp credentials not configured");
    }

    // Strip non-digits from phone number and ensure prefix
    const phone = message.to.replace(/\D/g, "");

    const url = `https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    
    const payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: message.body },
    };

    const attemptSend = async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        logger.child({ service: "whatsapp" }).error("WhatsApp delivery failed", { status: response.status });
        throw new HttpError(response.status, `WhatsApp API error: ${response.status}`);
      }

      logger.child({ service: "whatsapp" }).info("WhatsApp delivery completed");
    };

    await withRetry(attemptSend, { attempts: 1, isRetryable: isTransientHttpError });
  }
}
