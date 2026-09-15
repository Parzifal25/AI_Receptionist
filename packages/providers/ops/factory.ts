import type { OpsProvider } from "@halo/ports/ops-provider";
import { getServerEnv } from "@halo/platform/env";
import { LogOpsProvider } from "./log-ops-provider";

let cached: OpsProvider | null = null;

/**
 * Ops back-end selection is pure configuration, mirroring the messaging
 * factory. "log" ships today; a third-party FSM adapter (REST/webhook, quotes,
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
    // case "named-fsm": → NamedFsmProvider (FSM tickets, jobs, quotes, invoices…)
  }
  return cached;
}

/** Test helper. */
export function resetOpsProviderForTests(): void {
  cached = null;
}
