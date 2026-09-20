/**
 * Backoff for the worker's embed tick: after a tick reports "error" (the embed provider call
 * itself failed, not a per-row failure), ticks are skipped for a window starting at 5 minutes
 * and doubling per consecutive error, capped at 1 hour. A success or idle tick resets the
 * backoff immediately. The clock is injected so this is testable without real timers.
 *
 * The floor/cap are also injectable (via {@link EmbedBackoffOptions}) so other tick loops with
 * different tolerance for a routine blip can reuse this class instead of forking it — e.g. the
 * Telegram poll/notify ticks use a ~2 s floor / ~60 s cap (see scripts/worker.ts), since a 5 min
 * floor would make the bot look dead after one dropped connection or a single 429/502.
 */
export const EMBED_BACKOFF_INITIAL_MS = 5 * 60_000;
export const EMBED_BACKOFF_MAX_MS = 60 * 60_000;

export interface EmbedBackoffOptions {
  /** Delay for the first error after a reset. Defaults to {@link EMBED_BACKOFF_INITIAL_MS}. */
  initialMs?: number;
  /** Ceiling the doubling delay is capped at. Defaults to {@link EMBED_BACKOFF_MAX_MS}. */
  maxMs?: number;
  now?: () => number;
}

export class EmbedBackoff {
  private readonly initialMs: number;
  private readonly maxMs: number;
  private readonly now: () => number;
  private delayMs = 0;
  private nextAllowedAt = 0;

  /** Accepts either a bare clock function (the original signature) or an options object. */
  constructor(nowOrOptions: (() => number) | EmbedBackoffOptions = Date.now) {
    const opts: EmbedBackoffOptions = typeof nowOrOptions === "function" ? { now: nowOrOptions } : nowOrOptions;
    this.now = opts.now ?? Date.now;
    this.initialMs = opts.initialMs ?? EMBED_BACKOFF_INITIAL_MS;
    this.maxMs = opts.maxMs ?? EMBED_BACKOFF_MAX_MS;
  }

  /** True while a prior error's backoff window hasn't elapsed yet. */
  shouldSkip(): boolean {
    return this.now() < this.nextAllowedAt;
  }

  /** ms remaining until {@link shouldSkip} returns false; 0 when not currently backed off. */
  remainingMs(): number {
    return Math.max(0, this.nextAllowedAt - this.now());
  }

  /**
   * Call after a tick returns "error": doubles the delay (from the floor), capped at `maxMs`.
   * When the caller knows a specific wait is required (e.g. Telegram's 429 `retry_after`), pass
   * it as `overrideMs` — used as-is (still capped at `maxMs`) instead of the doubling delay, and
   * does not affect the doubling sequence for a subsequent plain `onError()` call.
   */
  onError(overrideMs?: number): void {
    if (overrideMs !== undefined) {
      this.nextAllowedAt = this.now() + Math.min(Math.max(overrideMs, 0), this.maxMs);
      return;
    }
    this.delayMs = this.delayMs === 0 ? this.initialMs : Math.min(this.delayMs * 2, this.maxMs);
    this.nextAllowedAt = this.now() + this.delayMs;
  }

  /** Call after a tick returns "embedded" or "idle": clears the backoff. */
  reset(): void {
    this.delayMs = 0;
    this.nextAllowedAt = 0;
  }
}
