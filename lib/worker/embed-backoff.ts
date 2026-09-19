/**
 * Backoff for the worker's embed tick: after a tick reports "error" (the embed provider call
 * itself failed, not a per-row failure), ticks are skipped for a window starting at 5 minutes
 * and doubling per consecutive error, capped at 1 hour. A success or idle tick resets the
 * backoff immediately. The clock is injected so this is testable without real timers.
 */
export const EMBED_BACKOFF_INITIAL_MS = 5 * 60_000;
export const EMBED_BACKOFF_MAX_MS = 60 * 60_000;

export class EmbedBackoff {
  private delayMs = 0;
  private nextAllowedAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** True while a prior error's backoff window hasn't elapsed yet. */
  shouldSkip(): boolean {
    return this.now() < this.nextAllowedAt;
  }

  /** Call after a tick returns "error": doubles the delay (from a 5 min floor), capped at 1 h. */
  onError(): void {
    this.delayMs = this.delayMs === 0 ? EMBED_BACKOFF_INITIAL_MS : Math.min(this.delayMs * 2, EMBED_BACKOFF_MAX_MS);
    this.nextAllowedAt = this.now() + this.delayMs;
  }

  /** Call after a tick returns "embedded" or "idle": clears the backoff. */
  reset(): void {
    this.delayMs = 0;
    this.nextAllowedAt = 0;
  }
}
