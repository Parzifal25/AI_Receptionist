import "server-only";
import crypto from "node:crypto";
import type { MessageChannel, MessagingProvider, OutboundMessage } from "@halo/ports/messaging-provider";
import { logger } from "@halo/platform/logger";
import { getServerEnv } from "@halo/platform/env";
import { HttpError, isTransientHttpError, withRetry } from "@halo/platform/retry";

/**
 * Resend messaging adapter: delivers emails via the Resend REST API.
 * Leverages the standard withRetry helper for resilience against transient
 * errors (429, 5xx) and uses idempotency keys to prevent duplicate emails
 * during retries.
 */
export class ResendMessagingProvider implements MessagingProvider {
  readonly name = "resend";
  private readonly log = logger.child({ provider: "messaging.resend" });

  supports(channel: MessageChannel): boolean {
    return channel === "email";
  }

  async send(message: OutboundMessage): Promise<void> {
    if (message.channel !== "email") {
      throw new Error(`Resend provider only supports email channel, got ${message.channel}`);
    }

    const env = getServerEnv();
    if (!env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is required for resend messaging provider");
    }

    const payload: Record<string, unknown> = {
      from: env.RESEND_FROM_EMAIL,
      to: message.to,
      subject: message.subject || "No Subject",
      text: message.body,
    };

    if (message.html) {
      payload.html = message.html;
    }

    if (message.attachments && message.attachments.length > 0) {
      payload.attachments = message.attachments.map((att) => ({
        filename: att.filename,
        content: Buffer.from(att.content, "utf8").toString("base64"),
      }));
    }

    // Idempotency key based on hash of (to + subject + body.slice(0,100))
    const hashBase = `${message.to}:${message.subject || ""}:${message.body.slice(0, 100)}`;
    const idempotencyKey = crypto.createHash("sha256").update(hashBase).digest("hex");

    await withRetry(
      async () => {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.RESEND_API_KEY}`,
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new HttpError(response.status, `Resend API error: ${response.status} ${response.statusText} ${text}`);
        }
      },
      {
        isRetryable: isTransientHttpError,
      }
    );

    this.log.info("outbound email sent via resend", {
      to: message.to,
      subject: message.subject,
      hasHtml: Boolean(message.html),
      attachmentsCount: message.attachments?.length || 0,
    });
  }
}
