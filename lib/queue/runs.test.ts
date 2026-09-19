import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, RunQueue } from "./runs";

function fakePool(claimRow: Record<string, unknown> | undefined) {
  const calls: string[] = [];
  const params: unknown[][] = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      calls.push(text);
      params.push(values);
      if (text.includes("UPDATE caphub_v2.analysis_runs r SET state = 'running'")) return { rows: claimRow ? [claimRow] : [], rowCount: claimRow ? 1 : 0 };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  return { calls, params, pool: { connect: async () => client, query: client.query } as never };
}

describe("RunQueue.claim", () => {
  it("returns lease when a queued run exists", async () => {
    const { pool } = fakePool({ id: "run_1", capture_id: "cap_1", pipeline: "minimax" });
    const lease = await new RunQueue(pool).claim("tok", new Date("2026-09-19T00:00:00Z"));
    expect(lease).toEqual({ runId: "run_1", captureId: "cap_1", pipeline: "minimax", ownerToken: "tok" });
  });
  it("returns null when nothing claimable and takes the worker advisory lock", async () => {
    const { pool, calls } = fakePool(undefined);
    expect(await new RunQueue(pool).claim("tok", new Date())).toBeNull();
    expect(calls.some((c) => c.includes("pg_advisory_xact_lock(hashtext('caphub_v2.worker')"))).toBe(true);
  });
  it("fails exhausted expired leases with LEASE_EXPIRED before claiming, and never reclaims them", async () => {
    const { pool, calls, params } = fakePool({ id: "run_2", capture_id: "cap_2", pipeline: "minimax" });
    const now = new Date("2026-09-19T00:00:00Z");
    const lease = await new RunQueue(pool).claim("tok", now);
    expect(lease?.runId).toBe("run_2");
    const failIdx = calls.findIndex((c) => c.includes("error_code = 'LEASE_EXPIRED'"));
    const claimIdx = calls.findIndex((c) => c.includes("UPDATE caphub_v2.analysis_runs r SET state = 'running'"));
    expect(calls.indexOf("BEGIN")).toBeLessThan(failIdx);
    expect(failIdx).toBeGreaterThan(-1);
    expect(failIdx).toBeLessThan(claimIdx);
    expect(claimIdx).toBeLessThan(calls.indexOf("COMMIT"));
    const fail = calls[failIdx];
    expect(fail).toContain("state = 'failed', owner_token = NULL, lease_until = NULL");
    expect(fail).toContain("finished_at = $1");
    expect(fail).toContain("WHERE state = 'running' AND lease_until <= $1 AND attempts >= $2");
    expect(params[failIdx]).toEqual([now.toISOString(), MAX_ATTEMPTS]);
    expect(MAX_ATTEMPTS).toBe(2);
    expect(calls[claimIdx]).toContain("(state = 'running' AND lease_until <= $1 AND attempts < $3)");
    expect(params[claimIdx]).toEqual([now.toISOString(), "tok", MAX_ATTEMPTS]);
  });
});
