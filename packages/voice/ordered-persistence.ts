import { logger } from "@halo/platform/logger";

export type VoiceWriteKind = "messages" | "state" | "tool_history";

/** W4.5: a call-local best-effort write queue, never an action executor.
 * Admission is not durability. No retries after ambiguous storage failures.
 */
export class OrderedVoicePersistence {
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private failures = 0;
  private closed = false;
  private closing: Promise<boolean> | null = null;

  constructor(private readonly capacity = 64) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error("Invalid voice persistence capacity");
  }

  status(): { pending: number; failures: number } {
    return { pending: this.pending, failures: this.failures };
  }

  enqueue(kind: VoiceWriteKind, work: () => Promise<void>): boolean {
    if (this.closed || this.pending >= this.capacity) {
      this.failures += 1;
      logger.warn("voice persistence admission failed", { kind, reason: this.closed ? "queue_closed" : "queue_full" });
      return false;
    }
    this.pending += 1;
    this.chain = this.chain.then(work).catch(() => {
      this.failures += 1;
      logger.warn("voice persistence failed", { kind, reason: "write_outcome_unknown" });
    }).finally(() => { this.pending -= 1; });
    return true;
  }

  /** Bounded close; a hung write is not cancelled/replayed or overtaken.
   * Late completion can drain the existing chain, but no new work is admitted.
   */
  close(timeoutMs = 5000): Promise<boolean> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const drained = await Promise.race([
          this.chain.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
            timer.unref?.();
          }),
        ]);
        if (!drained) logger.warn("voice persistence close pending", { reason: "write_outcome_unknown", pending: this.pending });
        return drained;
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return this.closing;
  }
}
