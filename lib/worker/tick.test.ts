import { describe, expect, it } from "vitest";
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
