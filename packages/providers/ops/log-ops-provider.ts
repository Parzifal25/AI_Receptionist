import { randomUUID } from "node:crypto";
import type { OpsProvider, OpsRecordInput, OpsRecordKind, OpsRecordResult } from "@halo/ports/ops-provider";
import { logger } from "@halo/platform/logger";

/**
 * Default ops adapter: records the request in the application log and mints
 * a synthetic id. Keeps ops_create journeys fully exercisable before a real
 * FSM/ERP back-end is connected — swapping in a named-vendor FSM is a factory change.
 */
export class LogOpsProvider implements OpsProvider {
  readonly name = "log";
  private readonly log = logger.child({ provider: "ops.log" });

  supports(_kind: OpsRecordKind): boolean {
    return true;
  }

  async createRecord(input: OpsRecordInput): Promise<OpsRecordResult> {
    const externalId = `log-${input.kind}-${randomUUID()}`;
    this.log.info("ops record (log-only)", {
      kind: input.kind,
      businessId: input.businessId,
      correlationId: input.correlationId,
      customer: input.customer ?? {},
      data: input.data,
      externalId,
    });
    return { externalId };
  }
}
