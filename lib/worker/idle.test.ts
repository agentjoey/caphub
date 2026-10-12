import { describe, expect, it } from "vitest";
import { DEFAULT_IDLE_POLICY, IdleTracker, idlePolicyFromEnv } from "./idle";

const policy = { busyIntervalMs: 2_000, graceCycles: 3, idlePollMs: 60_000 };

describe("IdleTracker", () => {
  it("may sleep only after the grace period of idle cycles", () => {
    const t = new IdleTracker(policy);
    t.record(false);
    t.record(false);
    expect(t.maySleep()).toBe(false);
    t.record(false);
    expect(t.maySleep()).toBe(true);
  });

  it("any busy cycle starts the grace period over", () => {
    const t = new IdleTracker(policy);
    t.record(false);
    t.record(false);
    t.record(true);
    t.record(false);
    t.record(false);
    expect(t.maySleep()).toBe(false);
  });

  it("reset (after a wake) starts it over too", () => {
    const t = new IdleTracker(policy);
    for (let i = 0; i < 5; i++) t.record(false);
    t.reset();
    expect(t.maySleep()).toBe(false);
  });
});

describe("idlePolicyFromEnv", () => {
  it("defaults to a 3-hour safety-net poll and a 30-second grace at 2 s", () => {
    expect(idlePolicyFromEnv({})).toEqual(DEFAULT_IDLE_POLICY);
    expect(DEFAULT_IDLE_POLICY.graceCycles * DEFAULT_IDLE_POLICY.busyIntervalMs).toBe(30_000);
    expect(DEFAULT_IDLE_POLICY.idlePollMs).toBe(3 * 60 * 60 * 1000);
  });

  it("takes WORKER_IDLE_POLL_MS, but never below a minute or from junk", () => {
    expect(idlePolicyFromEnv({ WORKER_IDLE_POLL_MS: "600000" }).idlePollMs).toBe(600_000);
    expect(idlePolicyFromEnv({ WORKER_IDLE_POLL_MS: "5" }).idlePollMs).toBe(DEFAULT_IDLE_POLICY.idlePollMs);
    expect(idlePolicyFromEnv({ WORKER_IDLE_POLL_MS: "soon" }).idlePollMs).toBe(DEFAULT_IDLE_POLICY.idlePollMs);
  });
});
