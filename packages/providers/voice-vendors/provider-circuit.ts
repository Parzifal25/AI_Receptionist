/**
 * Outage memory for a speech provider that has a fallback behind it.
 *
 * Without it every utterance during a vendor outage waits out the vendor's
 * own connect / first-audio deadline before the fallback is tried, so the
 * caller hears seconds of dead air before each line for as long as the outage
 * lasts. The circuit remembers the failure: after `failureThreshold`
 * consecutive RECOVERABLE failures the provider is skipped for `cooldownMs`,
 * then exactly one request is let through as a probe. A probe that works
 * closes the circuit and the primary is used again; one that fails re-opens
 * it for twice as long, up to `maxCooldownMs`.
 *
 * It never decides WHAT is recoverable — the fallback wrappers still do, by
 * the vendor's `retryable` flag — and it is never applied to the last
 * provider in a chain, so a request always has somewhere to go.
 */

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitOptions {
  /** Consecutive recoverable failures before the provider is skipped. */
  failureThreshold?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
  now?: () => number;
  onChange?: (change: { state: CircuitState; cooldownMs: number }) => void;
}

export const DEFAULT_CIRCUIT = { failureThreshold: 2, cooldownMs: 30_000, maxCooldownMs: 300_000 } as const;

export class ProviderCircuit {
  private readonly threshold: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly now: () => number;
  private current: CircuitState = "closed";
  private failures = 0;
  private cooldownMs: number;
  private retryAt = 0;
  private probing = false;

  constructor(private readonly options: CircuitOptions = {}) {
    this.threshold = options.failureThreshold ?? DEFAULT_CIRCUIT.failureThreshold;
    this.baseCooldownMs = options.cooldownMs ?? DEFAULT_CIRCUIT.cooldownMs;
    this.maxCooldownMs = Math.max(this.baseCooldownMs, options.maxCooldownMs ?? DEFAULT_CIRCUIT.maxCooldownMs);
    if (!Number.isInteger(this.threshold) || this.threshold < 1 || !(this.baseCooldownMs > 0)) throw new Error("Invalid speech circuit configuration");
    this.now = options.now ?? Date.now;
    this.cooldownMs = this.baseCooldownMs;
  }

  get state(): CircuitState { return this.current; }

  /** May the provider be tried now? Every `true` must be answered by exactly
   * one of `success()`, `failure()` or `release()`. */
  acquire(): boolean {
    if (this.current === "closed") return true;
    if (this.probing || this.now() < this.retryAt) return false;
    this.probing = true;
    this.set("half_open");
    return true;
  }

  success(): void {
    this.failures = 0; this.probing = false; this.cooldownMs = this.baseCooldownMs;
    this.set("closed");
  }

  failure(): void {
    if (this.current === "closed") {
      if (++this.failures < this.threshold) return;
    } else if (this.probing) this.cooldownMs = Math.min(this.cooldownMs * 2, this.maxCooldownMs);
    else return; // A late verdict from a request that started before the circuit opened.
    this.probing = false; this.retryAt = this.now() + this.cooldownMs;
    this.set("open", true);
  }

  /** The attempt ended without a verdict (the caller hung up or barged in). */
  release(): void {
    if (!this.probing) return;
    this.probing = false;
    this.set("open");
  }

  private set(state: CircuitState, announce = false): void {
    if (this.current === state && !announce) return;
    this.current = state;
    this.options.onChange?.({ state, cooldownMs: this.cooldownMs });
  }
}
