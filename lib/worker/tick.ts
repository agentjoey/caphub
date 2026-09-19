import type { Lease, RunQueue } from "../queue/runs";

export interface TickDeps {
  queue: Pick<RunQueue, "claim" | "heartbeat" | "finish">;
  run(lease: Lease, signal: AbortSignal): Promise<unknown>;
  clock(): Date;
  ownerToken(): string;
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
      const rawCode = error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : undefined;
      const code = typeof rawCode === "string" && rawCode.length > 0 ? rawCode : "UNAVAILABLE";
      const message = error instanceof Error ? error.message : String(error);
      await deps.queue.finish(lease, { state: "failed", errorCode: code, errorMessage: message.slice(0, 500) }, deps.clock());
    }
  } finally {
    clearInterval(heartbeat);
    signal.removeEventListener("abort", abort);
    await renewal;
  }
  return "processed";
}
