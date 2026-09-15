import { describe, expect, it, vi } from "vitest";
import { CompositeMessagingProvider } from "@halo/providers/messaging/composite-messaging-provider";
import { type MessagingProvider, type OutboundMessage } from "@halo/ports/messaging-provider";

describe("CompositeMessagingProvider", () => {
  it("routes message to correct sub-provider", async () => {
    const emailProvider: MessagingProvider = {
      name: "email",
      supports: (channel) => channel === "email",
      send: vi.fn().mockResolvedValue(undefined),
    };
    const whatsappProvider: MessagingProvider = {
      name: "whatsapp",
      supports: (channel) => channel === "whatsapp",
      send: vi.fn().mockResolvedValue(undefined),
    };
    
    const composite = new CompositeMessagingProvider([emailProvider, whatsappProvider]);

    const msg: OutboundMessage = {
      channel: "whatsapp",
      to: "1234567890",
      body: "Test",
    };

    await composite.send(msg);

    expect(whatsappProvider.send).toHaveBeenCalledWith(msg);
    expect(emailProvider.send).not.toHaveBeenCalled();
  });

  it("supports aggregated channels", () => {
    const provider1: MessagingProvider = {
      name: "1",
      supports: (channel) => channel === "sms",
      send: vi.fn(),
    };
    const provider2: MessagingProvider = {
      name: "2",
      supports: (channel) => channel === "whatsapp",
      send: vi.fn(),
    };

    const composite = new CompositeMessagingProvider([provider1, provider2]);
    
    expect(composite.supports("sms")).toBe(true);
    expect(composite.supports("whatsapp")).toBe(true);
    expect(composite.supports("email")).toBe(false);
  });

  it("throws if no provider supports the channel", async () => {
    const provider: MessagingProvider = {
      name: "sms-only",
      supports: (channel) => channel === "sms",
      send: vi.fn(),
    };

    const composite = new CompositeMessagingProvider([provider]);

    await expect(composite.send({
      channel: "email",
      to: "test@example.com",
      body: "Test",
    })).rejects.toThrow(/No provider configured for channel: email/);
  });
});
