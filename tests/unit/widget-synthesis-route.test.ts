import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ conversation: vi.fn(), context: vi.fn(), messages: vi.fn(), limit: vi.fn() }));
vi.mock("@/core/services/widget-repository", () => ({ WidgetRepository: class { getConversationByToken = mocks.conversation; getReceptionistById = mocks.context; getRecentMessages = mocks.messages; } }));
vi.mock("@halo/platform/rate-limit", () => ({ widgetMessageLimiter: { check: mocks.limit } }));
import { POST } from "@/app/api/v1/widget/synthesis/route";
import { signWebTts } from "@halo/voice/web-audio-auth";
const secret = "test-only-stream-secret-at-least-32-chars";
function request(extra: object = {}, origin = "https://tenant.test") { return new NextRequest("https://halo.test/api/v1/widget/synthesis", { method: "POST", headers: { origin }, body: JSON.stringify({ visitorToken: "test-visitor-token", ...extra }) }); }
beforeEach(() => {
 mocks.conversation.mockResolvedValue({ id: "conversation", businessId: "tenant", receptionistId: "receptionist", status: "active" });
 mocks.context.mockResolvedValue({ receptionist: { language: "te-IN", voiceEnabled: true }, business: { id: "tenant" }, allowedDomains: ["tenant.test"] });
 mocks.messages.mockResolvedValue([{ role: "assistant", content: "Validated HALO reply" }]);
 mocks.limit.mockResolvedValue({ allowed: true });
 vi.stubEnv("VOICE_GATEWAY_INTERNAL_URL", "http://localhost:8787"); vi.stubEnv("VOICE_STREAM_TOKEN_SECRET", secret);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
it("signs only the stored reply for this conversation, keeping credentials server-side", async () => {
 const fetchMock = vi.fn(async () => Response.json({ audio: "AAAA", format: { encoding: "pcm16le", sampleRate: 16000, channels: 1 } })); vi.stubGlobal("fetch", fetchMock);
 const response = await POST(request()); expect(response.status).toBe(200);
 const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
 expect(JSON.parse(String(init.body))).toMatchObject({ businessId: "tenant", text: "Validated HALO reply", language: "te-IN" });
 expect(init.headers).toMatchObject({ "x-halo-signature": signWebTts(secret, String(init.body)) });
 expect(JSON.stringify(await response.json())).not.toContain(secret);
});
it("refuses client-selected text and tenants", async () => { expect((await POST(request({ text: "unauthorized" }))).status).toBe(400); expect(mocks.conversation).not.toHaveBeenCalled(); });
it("rejects cross-origin and cross-tenant requests", async () => {
 const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
 expect((await POST(request({}, "https://attacker.test"))).status).toBe(403);
 mocks.conversation.mockResolvedValue({ businessId: "other", status: "active" });
 expect((await POST(request())).status).toBe(403); expect(fetchMock).not.toHaveBeenCalled();
});
it("refuses ended conversations and unvalidated user text", async () => {
 mocks.conversation.mockResolvedValue({ status: "ended" }); expect((await POST(request())).status).toBe(409);
 mocks.conversation.mockResolvedValue({ businessId: "tenant", status: "active" }); mocks.messages.mockResolvedValue([{ role: "user", content: "input" }]);
 expect((await POST(request())).status).toBe(409);
});
it("does not expose provider failure details", async () => {
 vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("sensitive-provider-secret")));
 const response = await POST(request()); expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("sensitive-provider-secret");
});
