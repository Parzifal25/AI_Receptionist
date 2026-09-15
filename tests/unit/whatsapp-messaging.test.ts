import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { WhatsappMessagingProvider } from "@halo/providers/messaging/whatsapp-messaging-provider";
import { resetEnvCacheForTests } from "@halo/platform/env";

describe("WhatsappMessagingProvider", () => {
  let provider: WhatsappMessagingProvider;
  
  beforeEach(() => {
    resetEnvCacheForTests();
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456";
    process.env.WHATSAPP_ACCESS_TOKEN = "token123";
    provider = new WhatsappMessagingProvider();
    
    // Mock global fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: "msg_123" }] }),
    });
  });
  
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("supports only whatsapp channel", () => {
    expect(provider.supports("whatsapp")).toBe(true);
    expect(provider.supports("sms")).toBe(false);
    expect(provider.supports("email")).toBe(false);
  });

  it("sends a message using correct Meta API format", async () => {
    await provider.send({
      channel: "whatsapp",
      to: "+1234567890",
      body: "Hello there",
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(global.fetch).mock.calls[0];
    
    expect(url).toBe("https://graph.facebook.com/v21.0/123456/messages");
    expect(options?.method).toBe("POST");
    expect(options?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer token123",
    });
    
    const body = JSON.parse(options?.body as string);
    expect(body).toEqual({
      messaging_product: "whatsapp",
      to: "1234567890", // Stripped +
      type: "text",
      text: { body: "Hello there" },
    });
  });

  it("retries on transient errors", async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.resolve({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ messages: [{ id: "msg_123" }] }),
      });
    });

    await provider.send({
      channel: "whatsapp",
      to: "1234567890",
      body: "Retry test",
    });

    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});
