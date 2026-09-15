import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ResendMessagingProvider } from "@halo/providers/messaging/resend-messaging-provider";
import { resetEnvCacheForTests } from "@halo/platform/env";
import { HttpError } from "@halo/platform/retry";
import crypto from "node:crypto";

const originalEnv = process.env;

function mockFetch(): ReturnType<typeof vi.fn> {
  return vi.fn();
}

beforeEach(() => {
  resetEnvCacheForTests();
  process.env = {
    ...originalEnv,
    NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    RESEND_API_KEY: "re_123456789",
    RESEND_FROM_EMAIL: "noreply@test.com",
    MESSAGING_PROVIDER: "resend",
  };

  global.fetch = mockFetch() as unknown as typeof global.fetch;
});

afterEach(() => {
  process.env = originalEnv;
  resetEnvCacheForTests();
  vi.restoreAllMocks();
});

describe("ResendMessagingProvider", () => {
  const provider = new ResendMessagingProvider();

  it("supports email only", () => {
    expect(provider.supports("email")).toBe(true);
    expect(provider.supports("sms")).toBe(false);
    expect(provider.supports("whatsapp")).toBe(false);
  });

  it("sends email successfully", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    await provider.send({
      channel: "email",
      to: "customer@example.com",
      subject: "Test Subject",
      body: "Test Body",
      html: "<p>Test Body</p>",
      attachments: [{ filename: "invite.ics", contentType: "text/calendar", content: "BEGIN:VCALENDAR" }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://api.resend.com/emails", expect.any(Object));

    const reqInit = fetchMock.mock.calls[0][1] as { headers: Record<string, string>; body: string };
    expect(reqInit.headers["Authorization"]).toBe("Bearer re_123456789");

    const body = JSON.parse(reqInit.body) as {
      from: string;
      to: string;
      subject: string;
      text: string;
      html: string;
      attachments: Array<{ filename: string; content: string }>;
    };
    expect(body.from).toBe("noreply@test.com");
    expect(body.to).toBe("customer@example.com");
    expect(body.subject).toBe("Test Subject");
    expect(body.text).toBe("Test Body");
    expect(body.html).toBe("<p>Test Body</p>");
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].filename).toBe("invite.ics");

    // Test base64 encoding
    expect(body.attachments[0].content).toBe(Buffer.from("BEGIN:VCALENDAR").toString("base64"));
  });

  it("generates correct idempotency key", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    const msg = {
      channel: "email" as const,
      to: "customer@example.com",
      subject: "Test Subject",
      body: "Test Body",
    };

    await provider.send(msg);

    const reqInit = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };

    const hashBase = `${msg.to}:${msg.subject}:${msg.body.slice(0, 100)}`;
    const expectedKey = crypto.createHash("sha256").update(hashBase).digest("hex");

    expect(reqInit.headers["Idempotency-Key"]).toBe(expectedKey);
  });

  it("retries on 429", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "Rate limit",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

    await provider.send({
      channel: "email",
      to: "customer@example.com",
      subject: "Test Subject",
      body: "Test Body",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 500", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal server error",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

    await provider.send({
      channel: "email",
      to: "customer@example.com",
      subject: "Test Subject",
      body: "Test Body",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 400", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "Bad request",
    });

    await expect(
      provider.send({
        channel: "email",
        to: "customer@example.com",
        subject: "Test Subject",
        body: "Test Body",
      }),
    ).rejects.toThrow(HttpError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
