/**
 * When the worker's main loop may stop polling (2026-10-12 Neon fix; see lib/worker/wake.ts).
 *
 * Busy, it checks every `busyIntervalMs` as before. After `graceCycles` consecutive cycles with
 * nothing done (~30 s), it is allowed to sleep — the caller still confirms no run is queued or
 * running before it does — until woken or `idlePollMs` passes. The grace period covers work the
 * worker creates for itself right after a run (enrichment, embeddings, notifications).
 */
export interface IdlePolicy {
  busyIntervalMs: number;
  graceCycles: number;
  idlePollMs: number;
}

export const DEFAULT_IDLE_POLICY: IdlePolicy = { busyIntervalMs: 2_000, graceCycles: 15, idlePollMs: 3 * 60 * 60 * 1000 };

/** Reads `WORKER_IDLE_POLL_MS` (the safety-net self-wake while asleep) over the default; ignores junk. */
export function idlePolicyFromEnv(env: Readonly<Record<string, string | undefined>>): IdlePolicy {
  const raw = Number(env.WORKER_IDLE_POLL_MS);
  const idlePollMs = Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : DEFAULT_IDLE_POLICY.idlePollMs;
  return { ...DEFAULT_IDLE_POLICY, idlePollMs };
}

export class IdleTracker {
  private idleCycles = 0;

  constructor(private readonly policy: IdlePolicy) {}

  /** Records one main-loop cycle: `busy` if any tick did something. */
  record(busy: boolean): void {
    this.idleCycles = busy ? 0 : this.idleCycles + 1;
  }

  /** True once the grace period of idle cycles has run out. */
  maySleep(): boolean {
    return this.idleCycles >= this.policy.graceCycles;
  }

  /** After a wake: start the grace period over, so a burst of new work gets the busy cadence. */
  reset(): void {
    this.idleCycles = 0;
  }
}
