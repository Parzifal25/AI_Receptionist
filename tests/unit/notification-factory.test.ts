import { describe, it, expect, beforeEach, vi } from "vitest";
import { getNotificationProvider, resetNotificationProviderForTests } from "@halo/providers/notification/factory";
import { LogNotificationProvider } from "@halo/providers/notification/log-notification-provider";
import { ResendNotificationProvider } from "@halo/providers/notification/resend-notification-provider";
import { getServerEnv } from "@halo/platform/env";

vi.mock("@halo/platform/env", () => ({
  getServerEnv: vi.fn(),
}));

/** Minimal env fragment; only MESSAGING_PROVIDER drives selection. */
const envWith = (overrides: Record<string, string>) =>
  overrides as unknown as ReturnType<typeof getServerEnv>;

describe("getNotificationProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetNotificationProviderForTests();
  });

  it("selects log for MESSAGING_PROVIDER=log", () => {
    vi.mocked(getServerEnv).mockReturnValue(envWith({ MESSAGING_PROVIDER: "log" }));
    expect(getNotificationProvider()).toBeInstanceOf(LogNotificationProvider);
  });

  it("selects resend for MESSAGING_PROVIDER=resend", () => {
    vi.mocked(getServerEnv).mockReturnValue(envWith({ MESSAGING_PROVIDER: "resend" }));
    expect(getNotificationProvider()).toBeInstanceOf(ResendNotificationProvider);
  });

  it("selects resend for MESSAGING_PROVIDER=resend+whatsapp", () => {
    vi.mocked(getServerEnv).mockReturnValue(envWith({ MESSAGING_PROVIDER: "resend+whatsapp" }));
    expect(getNotificationProvider()).toBeInstanceOf(ResendNotificationProvider);
  });

  it("selects log for MESSAGING_PROVIDER=whatsapp (no email capability)", () => {
    vi.mocked(getServerEnv).mockReturnValue(envWith({ MESSAGING_PROVIDER: "whatsapp" }));
    expect(getNotificationProvider()).toBeInstanceOf(LogNotificationProvider);
  });

  it("memoizes the provider until reset", () => {
    vi.mocked(getServerEnv).mockReturnValue(envWith({ MESSAGING_PROVIDER: "resend" }));
    const first = getNotificationProvider();
    expect(getNotificationProvider()).toBe(first);
    resetNotificationProviderForTests();
    expect(getNotificationProvider()).not.toBe(first);
  });
});
