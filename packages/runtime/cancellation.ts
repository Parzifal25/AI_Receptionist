/**
 * HALO Phase 3 — turn cancellation for interruptible channels.
 *
 * A caller who talks over a phone agent cancels the turn in flight. The
 * runtime honours `RuntimeInput.signal` only while the turn is UNCOMMITTED:
 * before any action has succeeded. Once an action committed (a booking, a
 * saved contact, a recorded handoff) the turn runs to completion so its
 * narration, transcript and conversation state stay consistent with what
 * the business systems now contain; the channel decides whether the reply
 * is still delivered.
 *
 * A cancelled turn persists nothing: no transcript rows, no state.
 */
export class RuntimeCancelledError extends Error {
  constructor(readonly stage: string) {
    super(`runtime turn cancelled (${stage})`);
    this.name = "RuntimeCancelledError";
  }
}

export function isRuntimeCancelled(error: unknown): error is RuntimeCancelledError {
  return error instanceof RuntimeCancelledError;
}
