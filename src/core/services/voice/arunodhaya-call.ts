import "server-only";
import { pendingFactGuidance, requireArunodhaya } from "@/content/tenants/arunodhaya";
import type { SalesCallConfig } from "./sales-call";

/**
 * HALO Phase 4 — the Arunodhaya wiring.
 *
 * The ONLY file that names this business. It reads the validated tenant
 * bundle and hands it to the generic sales-call assembly; the assembly, the
 * runtime, the voice gateway and every package remain unaware of it.
 *
 * If the bundle is invalid this throws at wiring time, before any call is
 * answered. That is deliberate: a sales agent running with half a commercial
 * policy is worse than one that will not start.
 */
export function arunodhayaSalesCallConfig(): SalesCallConfig {
  const bundle = requireArunodhaya();
  const guidance = pendingFactGuidance(bundle.facts, bundle.language);
  return {
    qualification: bundle.qualification,
    objections: bundle.objections,
    negotiation: bundle.negotiation,
    staticSections: guidance ? [guidance] : [],
    liveTransferReasons: [...bundle.escalation.liveTransferReasons],
    language: bundle.language,
  };
}
