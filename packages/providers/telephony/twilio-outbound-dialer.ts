import type { DialResult, OutboundDialer } from "@halo/ports/outbound-dialer";

/** One HTTP attempt per durable campaign claim. An ambiguous response is
 * quarantined by HALO; Twilio call creation is not assumed to be idempotent. */
export class TwilioOutboundDialer implements OutboundDialer {
  private readonly base: URL;
  constructor(private readonly options: { accountSid: string; authToken: string; gatewayUrl: string; fetchImpl?: typeof fetch }) {
    this.base = new URL(options.gatewayUrl);
    if (this.base.protocol !== "https:" || this.base.username || this.base.password || this.base.search || this.base.hash ||
      !/^AC[a-f0-9]{32}$/i.test(options.accountSid) || !options.authToken) throw new Error("Invalid outbound provider configuration");
  }
  async dial(input: Parameters<OutboundDialer["dial"]>[0]): Promise<DialResult> {
    if (!/^\+[1-9]\d{7,14}$/.test(input.from) || !/^\+[1-9]\d{7,14}$/.test(input.to) ||
        !/^[a-f0-9-]{36}:[1-9]\d?$/.test(input.idempotencyKey)) return { status: "rejected", retryable: false };
    const answer = new URL("/telephony/twilio/outbound", this.base);
    answer.searchParams.set("attempt", input.idempotencyKey);
    const status = new URL("/telephony/twilio/status", this.base);
    status.searchParams.set("attempt", input.idempotencyKey);
    const body = new URLSearchParams({ To: input.to, From: input.from, Url: answer.href, Method: "POST",
      StatusCallback: status.href, StatusCallbackMethod: "POST", StatusCallbackEvent: "completed", Timeout: "30" });
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`https://api.twilio.com/2010-04-01/Accounts/${this.options.accountSid}/Calls.json`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), body,
        headers: { Authorization: `Basic ${Buffer.from(`${this.options.accountSid}:${this.options.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded" },
      });
      if (response.status === 429) return { status: "rejected", retryable: true };
      if (response.status >= 400 && response.status < 500 && response.status !== 408) return { status: "rejected", retryable: false };
      if (!response.ok) return { status: "unknown" };
      const result: unknown = await response.json();
      const sid = typeof result === "object" && result !== null && "sid" in result ? result.sid : undefined;
      return typeof sid === "string" && /^CA[a-f0-9]{32}$/i.test(sid) ? { status: "accepted", providerCallId: sid } : { status: "unknown" };
    } catch { return { status: "unknown" }; }
  }
}
