import { describe, expect, it, vi, beforeEach } from "vitest";
import { ResendMessagingProvider } from "@halo/providers/messaging/resend-messaging-provider";
import { getServerEnv } from "@halo/platform/env";

vi.mock("@halo/platform/env", () => ({
  getServerEnv: vi.fn(),
}));

/** Minimal env fragment the provider reads; cast keeps the test focused. */
const envFragment = (overrides: Record<string, string>) =>
  overrides as unknown as ReturnType<typeof getServerEnv>;

describe("ResendMessagingProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    global.fetch = vi.fn();
  });

  it("sends an email successfully", async () => {
    vi.mocked(getServerEnv).mockReturnValue(
      envFragment({
        RESEND_API_KEY: "test-key",
        RESEND_FROM_EMAIL: "test@example.com",
      }),
    );

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "123" }),
    } as Response);

    const provider = new ResendMessagingProvider();

    await provider.send({
      channel: "email",
      to: "recipient@example.com",
      subject: "Test Subject",
      body: "Test Body",
      html: "<p>Test Body</p>",
      attachments: [{ filename: "invite.ics", contentType: "text/calendar", content: "BEGIN:VCALENDAR" }],
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      }),
    );

    const callArgs = vi.mocked(fetch).mock.calls[0]?.[1];
    const body = JSON.parse((callArgs?.body as string) ?? "{}") as {
      from: string;
      to: string;
      attachments: Array<{ filename: string }>;
    };
    expect(body.from).toBe("test@example.com");
    expect(body.to).toBe("recipient@example.com");
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].filename).toBe("invite.ics");
  });

  it("retries on 429", async () => {
    vi.mocked(getServerEnv).mockReturnValue(
      envFragment({
        RESEND_API_KEY: "test-key",
        RESEND_FROM_EMAIL: "test@example.com",
      }),
    );

    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "Rate limited",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "123" }),
      } as Response);

    const provider = new ResendMessagingProvider();

    await provider.send({
      channel: "email",
      to: "recipient@example.com",
      subject: "Test Subject",
      body: "Test Body",
    });

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
