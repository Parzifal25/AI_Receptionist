import { logger } from "@halo/platform/logger";
import type { RuntimeEvent, RuntimeEventSink, RuntimeEventType, TrustedRequestContext } from "./contracts";

/**
 * HALO Phase 2 — runtime events (Workstream 13).
 *
 * Every turn emits a structured, tenant-safe event stream. `data` is
 * restricted to primitives and string arrays by the RuntimeEvent type, and
 * producers pass counts/names/codes/durations only — never message text,
 * prompt text, secrets or contact details.
 */

const log = logger.child({ service: "agent-runtime" });

/** Default sink: one structured log line per event. */
export class LoggerEventSink implements RuntimeEventSink {
  emit(event: RuntimeEvent): void {
    const { type, data, ...ids } = event;
    if (type === "runtime.failed" || type === "model.failed" || type === "llm.failed" ||
        type === "llm.exhausted" || type === "action.failed") {
      log.warn(type, { ...ids, ...data });
    } else {
      log.info(type, { ...ids, ...data });
    }
  }
}

/** Test/collector sink. */
export class CollectingEventSink implements RuntimeEventSink {
  readonly events: RuntimeEvent[] = [];
  emit(event: RuntimeEvent): void {
    this.events.push(event);
  }
}

/** Fans one event out to several sinks; a failing sink never breaks the turn. */
export class CompositeEventSink implements RuntimeEventSink {
  constructor(private readonly sinks: RuntimeEventSink[]) {}
  emit(event: RuntimeEvent): void {
    for (const sink of this.sinks) {
      try {
        sink.emit(event);
      } catch {
        // observability must never fail the conversation
      }
    }
  }
}

/** Per-turn emitter bound to the trusted ids; also records into `events`. */
export class TurnEvents {
  readonly events: RuntimeEvent[] = [];

  constructor(
    private readonly trusted: TrustedRequestContext,
    private readonly sink: RuntimeEventSink,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  emit(type: RuntimeEventType, data: RuntimeEvent["data"] = {}): void {
    const event: RuntimeEvent = {
      type,
      at: this.clock().toISOString(),
      turnId: this.trusted.turnId,
      conversationId: this.trusted.conversationId,
      businessId: this.trusted.businessId,
      ...(this.trusted.agentId ? { agentId: this.trusted.agentId } : {}),
      ...(this.trusted.agentVersionId ? { agentVersionId: this.trusted.agentVersionId } : {}),
      data,
    };
    this.events.push(event);
    try {
      this.sink.emit(event);
    } catch {
      // never let telemetry break the turn
    }
  }
}
