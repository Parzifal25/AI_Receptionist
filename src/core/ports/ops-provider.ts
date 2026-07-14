/**
 * Port for back-office operations systems (OpsCorp FSM and friends). A
 * workflow step — never business logic — asks the provider to create one
 * operational record: a field-service ticket, a technician job, a quote,
 * an invoice, an inventory reservation, or a payment. New back-ends
 * (OpsCorp REST, a partner FSM, an ERP) implement this port and register in
 * the factory; the workflow engine and every journey definition stay
 * untouched.
 */

export const OPS_RECORD_KINDS = [
  "fsm_ticket",
  "technician_job",
  "quote",
  "invoice",
  "inventory_reservation",
  "payment",
] as const;

export type OpsRecordKind = (typeof OPS_RECORD_KINDS)[number];

export interface OpsRecordInput {
  kind: OpsRecordKind;
  businessId: string;
  /** Threads the customer journey across systems. */
  correlationId: string;
  /** Who the record is about, as far as the journey knows. */
  customer?: { name?: string; email?: string; phone?: string };
  /** Kind-specific fields (job description, line items, amount, sku…). */
  data: Record<string, unknown>;
}

export interface OpsRecordResult {
  /** Identifier of the record in the downstream system. */
  externalId: string;
  detail?: Record<string, unknown>;
}

export interface OpsProvider {
  readonly name: string;
  /** Record kinds this back-end can create. */
  supports(kind: OpsRecordKind): boolean;
  /** Must throw on failure — the workflow engine owns retries. */
  createRecord(input: OpsRecordInput): Promise<OpsRecordResult>;
}
