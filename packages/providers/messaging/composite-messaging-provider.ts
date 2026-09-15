import "server-only";
import { type MessageChannel, type MessagingProvider, type OutboundMessage } from "@halo/ports/messaging-provider";
import { AppError } from "@halo/core/errors/app-error";

export class CompositeMessagingProvider implements MessagingProvider {
  readonly name = "composite";
  private providers: MessagingProvider[];

  constructor(providers: MessagingProvider[]) {
    this.providers = providers;
  }

  supports(channel: MessageChannel): boolean {
    return this.providers.some((p) => p.supports(channel));
  }

  async send(message: OutboundMessage): Promise<void> {
    const provider = this.providers.find((p) => p.supports(message.channel));
    if (!provider) {
      throw AppError.internal(`No provider configured for channel: ${message.channel}`);
    }
    return provider.send(message);
  }
}
