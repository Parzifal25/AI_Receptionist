import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), limit: vi.fn() }));
vi.mock("@/core/services/widget-repository", () => ({ WidgetRepository: class { getReceptionistByWidgetKey = mocks.lookup; } }));
vi.mock("@halo/platform/rate-limit", () => ({ widgetMessageLimiter: { check: mocks.limit } }));
import { POST } from "@/app/api/v1/widget/speech/route";
import { signWebAudio } from "@halo/voice/web-audio-auth";
const secret = "test-only-stream-secret-at-least-32-chars";
function request(extra: object = {}, origin = "https://tenant.test") {
  return new NextRequest("https://halo.test/api/v1/widget/speech", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ widgetKey: "public-key", audio: "AAAA", ...extra }) });
}
beforeEach(() => {
  mocks.lookup.mockResolvedValue({ receptionist: { language: "te-IN", voiceEnabled: true }, business: { id: "11111111-1111-4111-8111-111111111111" }, allowedDomains: ["tenant.test"] });
  mocks.limit.mockResolvedValue({ allowed: true });
  vi.stubEnv("VOICE_GATEWAY_INTERNAL_URL", "http://127.0.0.1:8787"); vi.stubEnv("VOICE_STREAM_TOKEN_SECRET", secret);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("widget speech proxy authorization", () => {
  it("derives tenant and language server-side and authenticates the gateway request", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: "real result from mock provider" }), { status: 200 })); vi.stubGlobal("fetch", fetchMock);
    const response = await POST(request()); expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const body = String(init.body);
    expect(JSON.parse(body)).toMatchObject({ businessId: "11111111-1111-4111-8111-111111111111", language: "te-IN", audio: "AAAA" });
    expect(init.headers).toMatchObject({ "x-halo-signature": signWebAudio(secret, body) });
    expect(await response.json()).toEqual({ data: { text: "real result from mock provider" } });
  });
  it("rejects foreign embed origins before sending audio", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect((await POST(request({}, "https://attacker.test"))).status).toBe(403); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects caller-supplied tenant or provider selection", async () => {
    expect((await POST(request({ businessId: "other-tenant" }))).status).toBe(400);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it("reports missing gateway configuration honestly", async () => {
    vi.stubEnv("VOICE_GATEWAY_INTERNAL_URL", "");
    const response = await POST(request()); expect(response.status).toBe(503);
    expect((await response.json()).error.message).toContain("not configured");
  });
  it("does not expose provider or network secrets on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("sensitive-provider-secret")));
    const response = await POST(request()); expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("sensitive-provider-secret");
  });
});
