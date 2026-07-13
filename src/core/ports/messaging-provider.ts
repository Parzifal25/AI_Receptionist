export type MessageChannel = "sms" | "whatsapp" | "email";

export interface OutboundMessage {
  channel: MessageChannel;
  /** Phone number (sms/whatsapp) or email address. */
  to: string;
  /** Plain-text body; providers handle their own formatting. */
  body: string;
  /** Subject line, used by email-capable providers. */
  subject?: string;
}

/**
 * Port for visitor-facing outbound messaging: booking confirmations and
 * reminders today; SMS (Twilio & co.) and WhatsApp adapters plug in here
 * without touching the booking engine. Implementations must throw on
 * failure — callers own retry policy.
 */
export interface MessagingProvider {
  readonly name: string;
  /** Channels this provider can actually deliver on. */
  supports(channel: MessageChannel): boolean;
  send(message: OutboundMessage): Promise<void>;
}
