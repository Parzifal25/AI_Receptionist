/** Adapter must either deduplicate this key or report an uncertain result.
 * Unknown network outcomes are NEVER automatically retried. */
export interface OutboundDialer {
  dial(input: { businessId: string; agentId: string; agentVersionId: string;
    from: string; to: string; idempotencyKey: string }): Promise<
      { status: "accepted"; providerCallId: string } |
      { status: "rejected"; retryable: boolean } | { status: "unknown" }>;
}

export type DialResult = Awaited<ReturnType<OutboundDialer["dial"]>>;
