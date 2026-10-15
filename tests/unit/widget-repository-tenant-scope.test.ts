import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { WidgetRepository } from "@/core/services/widget-repository";

/**
 * Phase 2, Workstream 1 — the web conversation store enforces the tenant
 * the runtime hands it. WidgetRepository uses the service-role client, which
 * bypasses RLS, so a query that names only a conversation or lead id is
 * scoped by nothing but the caller's care. The voice store already filters
 * history by tenant; the web store must do the same.
 */
type Query = { table: string; op: string; filters: Array<[string, unknown]> };

function recordingClient(rows: Record<string, unknown[]> = {}) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const query: Query = { table, op: "select", filters: [] };
      queries.push(query);
      const result = () => ({ data: rows[table] ?? [], error: null });
      const builder = {
        select: () => builder,
        insert: () => { query.op = "insert"; return Promise.resolve({ error: null }); },
        update: () => { query.op = "update"; return builder; },
        eq: (column: string, value: unknown) => { query.filters.push([column, value]); return builder; },
        in: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: (rows[table] ?? [])[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, queries };
}

describe("WidgetRepository scopes service-role queries to the trusted tenant", () => {
  it("loads model history only from the given tenant's conversation", async () => {
    const { client, queries } = recordingClient({ messages: [{ role: "user", content: "hi" }] });
    await new WidgetRepository(client).getRecentMessages("conversation-a", "tenant-a", 5);
    expect(queries).toEqual([{ table: "messages", op: "select", filters: [["conversation_id", "conversation-a"], ["business_id", "tenant-a"]] }]);
  });

  it("finds and updates a conversation's lead only within the given tenant", async () => {
    const { client, queries } = recordingClient({ leads: [{ id: "lead-a", name: "", email: "", phone: "", intent: "" }] });
    await new WidgetRepository(client).upsertConversationLead("tenant-a", "conversation-a", { name: "Synthetic", phone: "+15550000000" });
    const leadQueries = queries.filter((q) => q.table === "leads");
    expect(leadQueries).toHaveLength(2);
    for (const query of leadQueries) expect(query.filters).toContainEqual(["business_id", "tenant-a"]);
    expect(leadQueries[1]).toMatchObject({ op: "update", filters: expect.arrayContaining([["id", "lead-a"]]) });
  });
});
