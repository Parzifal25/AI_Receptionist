import { expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseWorkflowStore } from "@halo/workflows/supabase-workflow-store";
import { WorkflowEngine } from "@halo/workflows/engine";
import { telemetryId, withTelemetryContext } from "@halo/platform/telemetry";

it("production timer deserialization retains persisted correlation through the engine", async () => {
  const correlation = "11111111-1111-4111-8111-111111111111";
  const db = { rpc: async () => ({ error: null, data: [{ business_id: "tenant-a", event_type: "lead.created", payload: {}, correlation_id: "journey", telemetry_correlation_id: correlation }] }) } as unknown as SupabaseClient;
  const store = new SupabaseWorkflowStore(db);
  store.claimDueRuns = async () => [];
  const seen: Array<string | undefined> = [];
  await withTelemetryContext(() => new WorkflowEngine(store, {}).processDue({ emit: async () => { seen.push(telemetryId()); } }), "22222222-2222-4222-8222-222222222222");
  expect(seen).toEqual([correlation]);
  expect(telemetryId()).toBeUndefined();
});
