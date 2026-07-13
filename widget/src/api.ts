/** Minimal API client for the widget. Talks only to the public widget API. */

export interface WidgetConfig {
  receptionistName: string;
  businessName: string;
  greeting: string;
  language: string;
  voiceEnabled: boolean;
  branding: {
    theme: "light" | "dark" | "auto";
    primaryColor: string;
    position: "bottom-right" | "bottom-left";
    avatarUrl: string;
    launcherLabel: string;
  };
}

interface ApiEnvelope<T> {
  data?: T;
  error?: { code: string; message: string };
}

/** API failure carrying the server's machine-readable error code. */
export class WidgetApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "WidgetApiError";
  }
}

export class WidgetApi {
  constructor(
    private readonly baseUrl: string,
    private readonly widgetKey: string,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
    const body = (await response.json().catch(() => ({}))) as ApiEnvelope<T>;
    if (!response.ok || body.error || body.data === undefined) {
      throw new WidgetApiError(
        body.error?.message ?? "Something went wrong",
        body.error?.code ?? "UNKNOWN",
      );
    }
    return body.data;
  }

  getConfig(): Promise<WidgetConfig> {
    return this.request<WidgetConfig>(
      `/api/v1/widget/config?key=${encodeURIComponent(this.widgetKey)}`,
    );
  }

  startConversation(channel: "chat" | "voice"): Promise<{ visitorToken: string; greeting: string }> {
    return this.request(`/api/v1/widget/conversations`, {
      method: "POST",
      body: JSON.stringify({
        widgetKey: this.widgetKey,
        channel,
        pageUrl: window.location.href,
      }),
    });
  }

  sendMessage(visitorToken: string, message: string): Promise<{ reply: string }> {
    return this.request(`/api/v1/widget/messages`, {
      method: "POST",
      body: JSON.stringify({ visitorToken, message }),
    });
  }
}
