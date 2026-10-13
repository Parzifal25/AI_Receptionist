import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@halo/platform/logger";

afterEach(() => vi.restoreAllMocks());
describe("structured error log privacy", () => {
  it("keeps operational identifiers but omits raw upstream errors and credentials", () => {
    const sink = vi.spyOn(console, "error").mockImplementation(() => {});
    createLogger({ route: "synthetic.route" }).error("request failed", {
      correlationId: "synthetic-turn", code: "PROVIDER_ERROR", category: "timeout", inputTokens: 10,
      error: new Error("synthetic-private-prompt and synthetic-secret"),
      nested: { authorization: "synthetic-secret", access_token: "synthetic-secret", refreshToken: "synthetic-secret", password: "synthetic-secret", apiKey: "synthetic-secret" },
    });
    const output = String(sink.mock.calls[0][0]);
    expect(output).not.toContain("synthetic-secret");
    expect(output).not.toContain("synthetic-private-prompt");
    expect(JSON.parse(output)).toMatchObject({ route: "synthetic.route", correlationId: "synthetic-turn", code: "PROVIDER_ERROR", category: "timeout", inputTokens: 10 });
  });
  it("redacts string database errors, message bodies and nested exception causes", () => {
    const sink = vi.spyOn(console, "warn").mockImplementation(() => {});
    createLogger().warn("database write failed", { error: "synthetic-private-row", body: "synthetic-private-row", details: { message: "synthetic-private-row", cause: new Error("synthetic-private-row") } });
    expect(String(sink.mock.calls[0][0])).not.toContain("synthetic-private-row");
  });
});
