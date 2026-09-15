import { describe, expect, it, vi, beforeEach } from "vitest";
import { WhatsappMessagingProvider } from "@halo/providers/messaging/whatsapp-messaging-provider";
import { getServerEnv } from "@halo/platform/env";

vi.mock("@halo/platform/env", () => ({
  getServerEnv: vi.fn(),
}));

/** Minimal env fragment the provider reads; cast keeps the test focused. */
const envFragment = (overrides: Record<string, string>) =>
  overrides as unknown as ReturnType<typeof getServerEnv>;

describe("WhatsappMessagingProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    global.fetch = vi.fn();
  });

  it("normalizes phone number and delivers message", async () => {
    vi.mocked(getServerEnv).mockReturnValue(
      envFragment({
        WHATSAPP_PHONE_NUMBER_ID: "phone-id",
        WHATSAPP_ACCESS_TOKEN: "token",
      }),
    );

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [{ id: "msg-id" }] }),
    } as Response);

    const provider = new WhatsappMessagingProvider();

    await provider.send({
      channel: "whatsapp",
      to: "+1 (555) 123-4567",
      subject: "Test",
      body: "Test WhatsApp message",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://graph.facebook.com/v21.0/phone-id/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token",
        }),
      }),
    );

    const callArgs = vi.mocked(fetch).mock.calls[0]?.[1];
    const body = JSON.parse((callArgs?.body as string) ?? "{}") as {
      to: string;
      text: { body: string };
    };
    // Should strip non-digits
    expect(body.to).toBe("15551234567");
    expect(body.text.body).toBe("Test WhatsApp message");
  });

  it("handles API errors properly", async () => {
    vi.mocked(getServerEnv).mockReturnValue(
      envFragment({
        WHATSAPP_PHONE_NUMBER_ID: "phone-id",
        WHATSAPP_ACCESS_TOKEN: "token",
      }),
    );

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "Bad request",
    } as Response);

    const provider = new WhatsappMessagingProvider();

    await expect(
      provider.send({
        channel: "whatsapp",
        to: "+15551234567",
        subject: "Test",
        body: "Test error handling",
      }),
    ).rejects.toThrow(/WhatsApp API error: 400/);
  });
});
