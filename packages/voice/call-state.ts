import { TERMINAL_CALL_STATES, type CallDirection, type CallState } from "@halo/core/domain/voice";
import { AppError } from "@halo/core/errors/app-error";

/**
 * HALO Phase 3 — technical call state machine (plan §P5.3).
 *
 *   created ─▶ queued ─▶ dialing ─▶ ringing ─▶ connected ─▶ in_conversation ─▶ completing ─▶ completed
 *      │         │         │          │           │              │  ▲               ▲
 *      │         │         │          │           │              ▼  │               │
 *      │         │         │          │           │          interrupted ───────────┤
 *      │         │         │          │           │              │                  │
 *      │         │         │          │           └──────────────┴─▶ transferred    │
 *      │         │         │          ├─▶ no_answer / busy                           │
 *      │         │         ├─▶ failed (any non-terminal state may fail)             │
 *      │         └─▶ cancelled                                                      │
 *      └────────────────────────────────────────────────────────────────────────────┘
 *
 * Inbound calls start at `ringing` (created/queued/dialing are outbound-only).
 * `interrupted` is the media-dropped state: it may recover to
 * `in_conversation` (one media reconnect) or proceed to `completing`.
 * Terminal states accept nothing. The same graph is enforced for terminal
 * protection by the 0020 Postgres trigger, so a late provider webhook can
 * never resurrect a finished call even through the service role.
 *
 * Same pattern as scheduling/appointment-state.ts.
 */
const TRANSITIONS: Record<CallState, CallState[]> = {
  created: ["queued", "dialing", "cancelled", "failed"],
  queued: ["dialing", "cancelled", "failed"],
  dialing: ["ringing", "connected", "no_answer", "busy", "failed", "cancelled"],
  ringing: ["connected", "no_answer", "busy", "failed", "cancelled"],
  connected: ["in_conversation", "completing", "transferred", "failed"],
  in_conversation: ["interrupted", "completing", "transferred", "failed"],
  interrupted: ["in_conversation", "completing", "failed"],
  completing: ["completed", "failed"],
  completed: [],
  transferred: [],
  no_answer: [],
  busy: [],
  failed: [],
  cancelled: [],
};

export function initialCallState(direction: CallDirection): CallState {
  return direction === "inbound" ? "ringing" : "created";
}

export function isTerminalCallState(state: CallState): boolean {
  return TERMINAL_CALL_STATES.includes(state);
}

export function canTransitionCall(from: CallState, to: CallState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertCallTransition(from: CallState, to: CallState): void {
  if (!canTransitionCall(from, to)) {
    throw AppError.conflict(`Cannot move call from ${from} to ${to}`, { reason: "invalid_call_transition" });
  }
}

/** The allowed-transition table (exported for the migration parity test). */
export function callTransitionTable(): Readonly<Record<CallState, readonly CallState[]>> {
  return TRANSITIONS;
}

/**
 * The shortest legal path from `from` to `to` (inclusive of `to`, exclusive of
 * `from`), or null. Used to apply a provider status that skips intermediate
 * states (e.g. an inbound `completed` webhook while we are `in_conversation`
 * must pass through `completing`), so every stored transition stays legal.
 */
export function pathToCallState(from: CallState, to: CallState): CallState[] | null {
  if (from === to) return [];
  const queue: Array<{ state: CallState; path: CallState[] }> = [{ state: from, path: [] }];
  const seen = new Set<CallState>([from]);
  while (queue.length > 0) {
    const { state, path } = queue.shift()!;
    for (const next of TRANSITIONS[state]) {
      if (seen.has(next)) continue;
      const nextPath = [...path, next];
      if (next === to) return nextPath;
      seen.add(next);
      queue.push({ state: next, path: nextPath });
    }
  }
  return null;
}
