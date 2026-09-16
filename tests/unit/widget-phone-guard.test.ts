import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WidgetRepository } from "@/core/services/widget-repository";

/** Phase 3: a widget visitor token can never address a phone conversation. */
function dbReturning(row: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

const base = {
  id: "c1",
  business_id: "b1",
  receptionist_id: "r1",
  visitor_token: "t".repeat(32),
  status: "active",
  message_count: 0,
  started_at: "2026-09-16T00:00:00Z",
  last_message_at: "2026-09-16T00:00:00Z",
  agent_id: null,
  agent_version_id: null,
};

describe("WidgetRepository.getConversationByToken — phone guard", () => {
  it("returns widget conversations", async () => {
    const repo = new WidgetRepository(dbReturning({ ...base, channel: "chat" }));
    await expect(repo.getConversationByToken(base.visitor_token)).resolves.toMatchObject({ id: "c1" });
  });

  it("refuses phone conversations as not found", async () => {
    const repo = new WidgetRepository(dbReturning({ ...base, channel: "phone", receptionist_id: null }));
    await expect(repo.getConversationByToken(base.visitor_token)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
