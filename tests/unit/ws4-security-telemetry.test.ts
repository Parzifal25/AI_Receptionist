import { afterEach, expect, it, vi } from "vitest";
import { createLogger } from "@halo/platform/logger";
import { observe, telemetryId, withTelemetryContext } from "@halo/platform/telemetry";
import { GoogleCalendarProvider } from "@halo/providers/calendar/google-calendar-provider";
import { OutlookCalendarProvider } from "@halo/providers/calendar/outlook-calendar-provider";
import { withRetry } from "@halo/platform/retry";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const event = { title: "synthetic-private", description: "synthetic-private", startsAt: "2026-10-15T09:00:00Z", endsAt: "2026-10-15T10:00:00Z", timezone: "UTC" };

it.each(["synthetic-private\nforged", "-".repeat(36), "a".repeat(36), ""])("replaces malformed context %s once for logs, retries and observations", async id => {
  vi.stubEnv("HALO_TELEMETRY", "stdout");
  const sink = vi.spyOn(console, "log").mockImplementation(() => {});
  await withTelemetryContext(async () => {
    const generated = telemetryId();
    expect(generated).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    createLogger().info("safe event");
    let attempt = 0;
    await withRetry(async () => { if (!attempt++) throw new Error("synthetic-private"); }, { sleep: async () => {} });
    observe("tool.outcome", { outcome: "ok" });
    const rows = sink.mock.calls.map(c => JSON.parse(String(c[0])));
    expect(rows.every(row => (row.telemetry ?? row).correlationId === generated)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("synthetic-private");
  }, id);
});

it("protects envelope fields and nested credential/customer containers", () => {
  const sink = vi.spyOn(console, "warn").mockImplementation(() => {});
  createLogger().warn("safe event", { msg: "synthetic-private", level: "forged", time: "forged", correlationId: "synthetic-private", nested: { headers: { "x-api-key": "synthetic-private" }, data: { customer: "synthetic-private" }, client_secret: "synthetic-private", id_token: "synthetic-private" } });
  const output = String(sink.mock.calls[0][0]);
  expect(output).not.toContain("synthetic-private");
  expect(JSON.parse(output)).toMatchObject({ msg: "safe event", level: "warn" });
});

for (const Provider of [GoogleCalendarProvider, OutlookCalendarProvider]) {
  it(`${Provider.name}: does not replay a create after success with a lost response, even for concurrent calls`, async () => {
    let committed = 0;
    const failure = new DOMException("synthetic-private", "TimeoutError");
    const fetcher = vi.fn(async () => { committed++; throw failure; });
    vi.stubGlobal("fetch", fetcher);
    const provider = new Provider(async () => "synthetic-token");
    const results = await Promise.allSettled([provider.createEvent("calendar", event), provider.createEvent("calendar", event)]);
    expect(results.every(r => r.status === "rejected" && r.reason === failure)).toBe(true);
    expect(committed).toBe(2); // one attempt per distinct invocation; no cross-invocation deduplication claimed
  });
  it(`${Provider.name}: omits private provider errors and retains retry exhaustion for reads`, async () => {
    vi.useFakeTimers();
    vi.stubEnv("HALO_TELEMETRY", "stdout");
    const sink = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetcher = vi.fn(async () => new Response("synthetic-private", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const provider = new Provider(async () => "synthetic-token");
    await expect(provider.createEvent("synthetic-private", event)).rejects.toThrow("Calendar request failed (503)");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const pending = expect(provider.listBusy("calendar", event.startsAt, event.endsAt)).rejects.toThrow("Calendar request failed (503)");
    await vi.runAllTimersAsync();
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(sink.mock.calls)).not.toContain("synthetic-private");
    expect(JSON.stringify(sink.mock.calls)).not.toContain("synthetic-token");
  });
}
