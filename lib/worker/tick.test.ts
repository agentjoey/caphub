import { afterEach, describe, expect, it, vi } from "vitest";
import { runTick } from "./tick";

const lease = { runId: "run_1", captureId: "cap_1", pipeline: "minimax" as const, ownerToken: "t" };

describe("runTick", () => {
  it("returns idle when nothing to claim", async () => {
    const queue = { claim: async () => null, heartbeat: async () => true, finish: async () => true };
    expect(await runTick({ queue, run: async () => {}, clock: () => new Date(), ownerToken: () => "t" }, new AbortController().signal)).toBe("idle");
  });
  it("finishes done on success and failed with code on error", async () => {
    const finished: unknown[] = [];
    const queue = { claim: async () => lease, heartbeat: async () => true, finish: async (_l: unknown, o: unknown) => { finished.push(o); return true; } };
    await runTick({ queue, run: async () => {}, clock: () => new Date(), ownerToken: () => "t" }, new AbortController().signal);
    await runTick({ queue, run: async () => { throw Object.assign(new Error("x"), { code: "TIMEOUT" }); }, clock: () => new Date(), ownerToken: () => "t" }, new AbortController().signal);
    expect(finished).toEqual([{ state: "done" }, { state: "failed", errorCode: "TIMEOUT", errorMessage: "x" }]);
  });
});

describe("runTick heartbeat loss", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("aborts the run and does not call finish when heartbeat reports lost ownership", async () => {
    vi.useFakeTimers();
    let finishCalled = false;
    let sawAbort = false;
    const queue = {
      claim: async () => lease,
      heartbeat: async () => false,
      finish: async () => { finishCalled = true; return true; }
    };
    const run = (_lease: typeof lease, signal: AbortSignal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => { sawAbort = true; resolve(); });
    });
    const promise = runTick({ queue, run, clock: () => new Date(), ownerToken: () => "t" }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;
    expect(sawAbort).toBe(true);
    expect(finishCalled).toBe(false);
  });

  it("does not call finish when run throws after the lease was lost", async () => {
    vi.useFakeTimers();
    let finishCalled = false;
    const queue = {
      claim: async () => lease,
      heartbeat: async () => false,
      finish: async () => { finishCalled = true; return true; }
    };
    const run = (_lease: typeof lease, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("lease lost")));
    });
    const promise = runTick({ queue, run, clock: () => new Date(), ownerToken: () => "t" }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;
    expect(finishCalled).toBe(false);
  });
});
