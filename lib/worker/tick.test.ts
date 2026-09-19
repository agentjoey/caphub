import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_ERROR_CODES, runErrorCode, runTick } from "./tick";

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

describe("runTick error codes", () => {
  async function failWith(error: unknown) {
    const finished: Array<{ errorCode?: string; errorMessage?: string }> = [];
    const queue = { claim: async () => lease, heartbeat: async () => true, finish: async (_l: unknown, o: { errorCode?: string; errorMessage?: string }) => { finished.push(o); return true; } };
    await runTick({ queue, run: async () => { throw error; }, clock: () => new Date(), ownerToken: () => "t" }, new AbortController().signal);
    return finished[0];
  }

  it("records every allow-listed code as-is", async () => {
    for (const code of RUN_ERROR_CODES) expect((await failWith(Object.assign(new Error(code), { code }))).errorCode).toBe(code);
  });

  it("records unknown codes (e.g. pg '23505'), missing codes and non-Error throws as INTERNAL, keeping the message truncated to 500", async () => {
    const pg = await failWith(Object.assign(new Error("x".repeat(600)), { code: "23505" }));
    expect(pg).toMatchObject({ errorCode: "INTERNAL" });
    expect(pg.errorMessage).toHaveLength(500);
    expect((await failWith(new Error("plain"))).errorCode).toBe("INTERNAL");
    expect(await failWith("boom")).toMatchObject({ errorCode: "INTERNAL", errorMessage: "boom" });
  });

  it("logs INTERNAL failures with the truncated message", async () => {
    const logged: unknown[] = [];
    const queue = { claim: async () => lease, heartbeat: async () => true, finish: async () => true };
    await runTick({ queue, run: async () => { throw new Error("y".repeat(600)); }, clock: () => new Date(), ownerToken: () => "t", log: (e) => logged.push(e) }, new AbortController().signal);
    await runTick({ queue, run: async () => { throw Object.assign(new Error("t"), { code: "TIMEOUT" }); }, clock: () => new Date(), ownerToken: () => "t", log: (e) => logged.push(e) }, new AbortController().signal);
    expect(logged).toEqual([{ runId: "run_1", internalError: "y".repeat(500) }]);
  });

  it("maps ProviderError-style and pipeline codes via runErrorCode", () => {
    expect(runErrorCode({ code: "CAPTURE_NOT_FOUND" })).toBe("CAPTURE_NOT_FOUND");
    expect(runErrorCode({ code: 42 })).toBe("INTERNAL");
    expect(runErrorCode(null)).toBe("INTERNAL");
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
