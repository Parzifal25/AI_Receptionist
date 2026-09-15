import { describe, expect, it, vi, beforeEach } from "vitest";
import { CompositeMessagingProvider } from "@halo/providers/messaging/composite-messaging-provider";
import type { MessagingProvider, MessageChannel } from "@halo/ports/messaging-provider";

describe("CompositeMessagingProvider", () => {
  let emailProvider: MessagingProvider;
  let whatsappProvider: MessagingProvider;

  beforeEach(() => {
    emailProvider = {
      name: "mock-email",
      supports: vi.fn((channel: MessageChannel) => channel === "email"),
      send: vi.fn().mockResolvedValue(undefined),
    };
    whatsappProvider = {
      name: "mock-whatsapp",
      supports: vi.fn((channel: MessageChannel) => channel === "whatsapp"),
      send: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("routes email to email provider", async () => {
    const composite = new CompositeMessagingProvider([emailProvider, whatsappProvider]);
    
    await composite.send({
      channel: "email",
      to: "test@example.com",
      subject: "Test",
      body: "Email body"
    });

    expect(emailProvider.send).toHaveBeenCalledTimes(1);
    expect(whatsappProvider.send).not.toHaveBeenCalled();
  });

  it("routes whatsapp to whatsapp provider", async () => {
    const composite = new CompositeMessagingProvider([emailProvider, whatsappProvider]);
    
    await composite.send({
      channel: "whatsapp",
      to: "+1234567890",
      subject: "Test",
      body: "WhatsApp body"
    });

    expect(whatsappProvider.send).toHaveBeenCalledTimes(1);
    expect(emailProvider.send).not.toHaveBeenCalled();
  });

  it("throws if no provider supports the channel", async () => {
    const composite = new CompositeMessagingProvider([emailProvider]);
    
    await expect(composite.send({
      channel: "whatsapp",
      to: "+1234567890",
      subject: "Test",
      body: "Body"
    })).rejects.toThrow(/No provider configured for channel: whatsapp/);
  });
});
