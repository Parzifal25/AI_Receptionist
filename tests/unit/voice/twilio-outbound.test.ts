import { describe, expect, it, vi } from "vitest";
import { TwilioOutboundDialer } from "@halo/providers/telephony/twilio-outbound-dialer";
const input = { businessId: "tenant", agentId: "agent", agentVersionId: "version", from: "+12025550100", to: "+12025550101",
  idempotencyKey: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:1" };
const options = { accountSid: `AC${"a".repeat(32)}`, authToken: "test-only", gatewayUrl: "https://gateway.example" };
describe("Twilio outbound contract", () => {
  it("binds trusted callbacks to the durable claim without forwarding tenant data", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ sid: `CA${"b".repeat(32)}` }));
    const result = await new TwilioOutboundDialer({ ...options, fetchImpl }).dial(input);
    expect(result).toEqual({ status: "accepted", providerCallId: `CA${"b".repeat(32)}` });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(`https://api.twilio.com/2010-04-01/Accounts/${options.accountSid}/Calls.json`);
    const body = init!.body as URLSearchParams;
    expect(new URL(body.get("Url")!).searchParams.get("attempt")).toBe(input.idempotencyKey);
    expect(body.get("To")).toBe(input.to);
    expect(body.get("StatusCallbackEvent")).toBe("completed");
    expect(init!.redirect).toBe("error");
    expect(body.toString()).not.toContain("tenant");
  });
  it.each([408, 500, 503])("quarantines ambiguous HTTP %s without retry", async status => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status }));
    expect(await new TwilioOutboundDialer({ ...options, fetchImpl }).dial(input)).toEqual({ status: "unknown" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("only schedules a retry for a definite rate-limit rejection", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 429 }));
    expect(await new TwilioOutboundDialer({ ...options, fetchImpl }).dial(input)).toEqual({ status: "rejected", retryable: true });
  });
  it("rejects non-phone destinations without a network request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await new TwilioOutboundDialer({ ...options, fetchImpl }).dial({ ...input, to: "https://attacker.example" })).toEqual({ status: "rejected", retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
