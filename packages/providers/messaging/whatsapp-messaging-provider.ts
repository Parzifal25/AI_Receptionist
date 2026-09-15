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
        const errorText = await response.text().catch(() => "Unknown error");
        logger.child({ service: "whatsapp" }).error(`WhatsApp API error: ${response.status} ${errorText}`);
        throw new HttpError(response.status, `WhatsApp API error: ${response.status}`);
      }

      const data = await response.json().catch(() => ({}));
      logger.child({ service: "whatsapp" }).info(`Delivered WhatsApp message to ${message.to}`, {
        messageId: data?.messages?.[0]?.id,
      });
    };

    await withRetry(attemptSend, { isRetryable: isTransientHttpError });
  }
}
