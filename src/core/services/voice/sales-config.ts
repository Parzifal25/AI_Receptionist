import { z } from "zod";
import type { AgentConfig } from "@halo/core/domain/agents";
import { parseQualificationSchema } from "@halo/qualification/schema";
import { parseNegotiationPolicy } from "@halo/negotiation/policy";
import { parseObjectionCatalog } from "@halo/negotiation/objections";
import type { SalesCallConfig } from "./sales-call";

const envelope = z.object({
  qualification: z.unknown(), negotiation: z.unknown(), objections: z.unknown(),
  staticSections: z.array(z.string().max(8000)).max(8),
  language: z.string().min(2).max(16),
  liveTransferReasons: z.array(z.enum(["explicit_human_request", "repeated_misunderstanding", "unsupported_request", "sensitive_situation", "action_failed", "low_confidence"])).max(6),
});

/** Stored inside the published version's existing policy envelope. Never load
 * a live business bundle over an older conversation's pinned configuration.
 */
export function salesConfigForVersion(config: AgentConfig): SalesCallConfig | null {
  const raw = config.tools.policy.sales;
  if (raw === undefined) return null;
  const value = envelope.safeParse(raw);
  if (!value.success) throw new Error("Invalid versioned sales configuration");
  const qualification = parseQualificationSchema(value.data.qualification);
  const negotiation = parseNegotiationPolicy(value.data.negotiation);
  const objections = parseObjectionCatalog(value.data.objections);
  if (!qualification.ok || !negotiation.ok || !objections.ok) throw new Error("Invalid versioned sales policy");
  return { ...value.data, qualification: qualification.schema, negotiation: negotiation.policy, objections: objections.catalog };
}
