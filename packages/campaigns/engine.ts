import { z } from "zod";

export const campaignPolicySchema = z.object({
  timezone: z.string().refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }),
  weekdays: z.array(z.int().min(0).max(6)).min(1).max(7),
  startMinute: z.int().min(0).max(1439), endMinute: z.int().min(1).max(1440),
  maxAttempts: z.int().min(1).max(10), retryDelaySeconds: z.int().min(60).max(2592000),
}).refine(p => p.startMinute < p.endMinute, "calling window must be within one local day");
export type CampaignPolicy = z.infer<typeof campaignPolicySchema>;

export function inCallingWindow(policy: CampaignPolicy, now: Date): boolean {
  const p = campaignPolicySchema.parse(policy);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: p.timezone, weekday: "short",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(value("weekday"));
  const minute = Number(value("hour")) * 60 + Number(value("minute"));
  return p.weekdays.includes(weekday) && minute >= p.startMinute && minute < p.endMinute;
}

/** Adapter must either deduplicate this key or report an uncertain result.
 * Unknown network outcomes are NEVER automatically retried. */
export interface OutboundDialer {
  dial(input: { businessId: string; agentId: string; agentVersionId: string;
    from: string; to: string; idempotencyKey: string }): Promise<
      { status: "accepted"; providerCallId: string } |
      { status: "rejected"; retryable: boolean } | { status: "unknown" }>;
}
export interface ClaimedContact {
  id: string; businessId: string; campaignId: string; customerId: string;
  agentId: string; agentVersionId: string; from: string; to: string; attempt: number;
}
export type DialResult = Awaited<ReturnType<OutboundDialer["dial"]>>;
export interface CampaignStore {
  /** Atomic SKIP LOCKED claim, including DNC, published version, policy and consent checks. */
  claim(businessId: string, campaignId: string, limit: number): Promise<ClaimedContact[]>;
  /** Rechecks suppression/pause after claiming and immediately before the external action. */
  authorize(contact: ClaimedContact): Promise<boolean>;
  settle(contact: ClaimedContact, result: DialResult): Promise<void>;
}
export class CampaignEngine {
  constructor(private readonly store: CampaignStore, private readonly dialer: OutboundDialer) {}
  async dispatch(businessId: string, campaignId: string, limit = 10): Promise<{ claimed: number; accepted: number; uncertain: number }> {
    if (!businessId || !campaignId || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid campaign batch");
    const contacts = await this.store.claim(businessId, campaignId, limit);
    let accepted = 0, uncertain = 0;
    for (const contact of contacts) {
      if (contact.businessId !== businessId || contact.campaignId !== campaignId) throw new Error("Campaign scope mismatch");
      let result: DialResult = { status: "rejected", retryable: false };
      if (await this.store.authorize(contact)) {
        try {
          result = await this.dialer.dial({ businessId, agentId: contact.agentId, agentVersionId: contact.agentVersionId,
            from: contact.from, to: contact.to, idempotencyKey: `${contact.id}:${contact.attempt}` });
        } catch { result = { status: "unknown" }; }
      }
      // A persistence failure leaves the claim in dialing, never available to a
      // second worker. Reconciliation must query the carrier before recovery.
      await this.store.settle(contact, result);
      if (result.status === "accepted") accepted++;
      if (result.status === "unknown") uncertain++;
    }
    return { claimed: contacts.length, accepted, uncertain };
  }
}
