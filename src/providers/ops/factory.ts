import type { OpsProvider } from "@/core/ports/ops-provider";
import { getServerEnv } from "@/lib/env";
import { LogOpsProvider } from "./log-ops-provider";

let cached: OpsProvider | null = null;

/**
 * Ops back-end selection is pure configuration, mirroring the messaging
 * factory. "log" ships today; an OpsCorp adapter (REST/webhook FSM, quotes,
 * invoicing, inventory, payments) slots in as a new case here — workflows
 * and the engine depend only on the OpsProvider port.
 */
export function getOpsProvider(): OpsProvider {
  if (cached) return cached;
  const env = getServerEnv();

  switch (env.OPS_PROVIDER) {
    case "log":
      cached = new LogOpsProvider();
      break;
    // case "opscorp": → OpsCorpProvider (FSM tickets, jobs, quotes, invoices…)
  }
  return cached;
}

/** Test helper. */
export function resetOpsProviderForTests(): void {
  cached = null;
}
