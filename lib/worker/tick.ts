import type { Lease, RunQueue } from "../queue/runs";

/** Error codes a failed run may record; any other thrown code (or none) is recorded as INTERNAL. */
export const RUN_ERROR_CODES = [
  "TIMEOUT", "AUTHENTICATION", "BILLING", "UNAVAILABLE", "INVALID_OUTPUT", "ABORTED", "BUDGET",
  "OBJECT_UNAVAILABLE", "PIPELINE_UNAVAILABLE", "CAPTURE_NOT_FOUND", "INVALID_IMAGE", "REASON_STEP_NOT_FOUND", "CAPABILITY_NOT_FOUND",
  "LEASE_LOST", "SUGGESTION_CHANGED"
] as const;
export type RunErrorCode = (typeof RUN_ERROR_CODES)[number] | "INTERNAL";

export function runErrorCode(error: unknown): RunErrorCode {
  const code = error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : undefined;
  return (RUN_ERROR_CODES as readonly unknown[]).includes(code) ? code as RunErrorCode : "INTERNAL";
}

export interface TickDeps {
  queue: Pick<RunQueue, "claim" | "heartbeat" | "finish">;
  run(lease: Lease, signal: AbortSignal): Promise<unknown>;
  clock(): Date;
  ownerToken(): string;
  /** Receives runs that failed with an unrecognised error (recorded as INTERNAL). */
  log?(entry: Record<string, unknown>): void;
}

export async function runTick(deps: TickDeps, signal: AbortSignal): Promise<"idle" | "processed"> {
  if (signal.aborted) return "idle";
  const lease = await deps.queue.claim(deps.ownerToken(), deps.clock());
  if (!lease) return "idle";
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  let renewal: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = deps.queue.heartbeat(lease, deps.clock())
      .then((owned) => { if (!owned) controller.abort(); })
      .catch(() => controller.abort())
      .finally(() => { renewal = undefined; });
  }, 30_000);
  try {
    await deps.run(lease, controller.signal);
    if (!controller.signal.aborted) await deps.queue.finish(lease, { state: "done" }, deps.clock());
  } catch (error) {
    if (!controller.signal.aborted) {
      const errorCode = runErrorCode(error);
      const errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      if (errorCode === "INTERNAL") deps.log?.({ runId: lease.runId, internalError: errorMessage });
      // A lease-fence failure means this runner has no authority to finish the run, even as
      // failed. Leave the row to its current owner / normal expiry reclaim path.
      if (errorCode !== "LEASE_LOST") await deps.queue.finish(lease, { state: "failed", errorCode, errorMessage }, deps.clock());
    }
  } finally {
    clearInterval(heartbeat);
    signal.removeEventListener("abort", abort);
    await renewal;
  }
  return "processed";
}
