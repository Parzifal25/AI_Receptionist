import type { MessageChannel, MessagingProvider, OutboundMessage } from "@halo/ports/messaging-provider";
import { logger } from "@halo/platform/logger";

/**
 * Default messaging adapter: logs instead of sending. Keeps the whole
 * confirmation/reminder pipeline exercisable in development and in
 * deployments that haven't connected an SMS/WhatsApp/email gateway yet —
 * swapping in Twilio & co. is a factory change, not a business-logic change.
 */
export class LogMessagingProvider implements MessagingProvider {
  readonly name = "log";
  private readonly log = logger.child({ provider: "messaging.log" });

  supports(_channel: MessageChannel): boolean {
    return true;
  }

  async send(message: OutboundMessage): Promise<void> {
    this.log.info("outbound message (log-only delivery)", {
      channel: message.channel,
      to: message.to,
      subject: message.subject ?? "",
      body: message.body,
      hasHtml: Boolean(message.html),
      attachments: (message.attachments ?? []).map((a) => a.filename),
    });
  }
}
