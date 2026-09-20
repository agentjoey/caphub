import { describe, expect, it } from "vitest";
import { enqueueEnrichRun, MAX_ATTEMPTS, RunQueue } from "./runs";

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
    expect(calls.some((c) => c.includes("pg_advisory_xact_lock(hashtext('caphub_v2.worker.' || $1)"))).toBe(true);
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
    expect(fail).toContain("WHERE state = 'running' AND kind = $3 AND lease_until <= $1 AND attempts >= $2");
    expect(params[failIdx]).toEqual([now.toISOString(), MAX_ATTEMPTS, "analysis"]);
    expect(MAX_ATTEMPTS).toBe(2);
    expect(calls[claimIdx]).toContain("(state = 'running' AND lease_until <= $1 AND attempts < $3)");
    expect(params[claimIdx]).toEqual([now.toISOString(), "tok", MAX_ATTEMPTS, "analysis", "120"]);
  });

  it("scopes claim to the requested kind and uses a longer lease for deep runs", async () => {
    const { pool, calls, params } = fakePool({ id: "run_deep", capture_id: "cap_deep", pipeline: "mixed" });
    const now = new Date("2026-09-19T00:00:00Z");
    const lease = await new RunQueue(pool).claim("tok", now, "deep");
    expect(lease?.runId).toBe("run_deep");
    const claimIdx = calls.findIndex((c) => c.includes("UPDATE caphub_v2.analysis_runs r SET state = 'running'"));
    expect(calls[claimIdx]).toContain("WHERE kind = $4");
    expect(calls[claimIdx]).toContain("AND kind = $4)");
    expect(params[claimIdx]).toEqual([now.toISOString(), "tok", MAX_ATTEMPTS, "deep", "360"]);
  });

  it("scopes claim to 'enrich' and uses the 4-minute enrich lease", async () => {
    const { pool, calls, params } = fakePool({ id: "run_enrich", capture_id: "cap_enrich", pipeline: "mixed" });
    const now = new Date("2026-09-19T00:00:00Z");
    const lease = await new RunQueue(pool).claim("tok", now, "enrich");
    expect(lease?.runId).toBe("run_enrich");
    const claimIdx = calls.findIndex((c) => c.includes("UPDATE caphub_v2.analysis_runs r SET state = 'running'"));
    expect(params[claimIdx]).toEqual([now.toISOString(), "tok", MAX_ATTEMPTS, "enrich", "240"]);
  });
});

describe("RunQueue.heartbeat", () => {
  it("renews the lease using the analysis duration by default", async () => {
    const params: unknown[][] = [];
    const pool = { query: async (_t: string, v: unknown[] = []) => { params.push(v); return { rowCount: 1 }; } };
    const ok = await new RunQueue(pool as never).heartbeat({ runId: "r1", captureId: "c1", pipeline: "minimax", ownerToken: "tok" }, new Date("2026-09-19T00:00:00Z"));
    expect(ok).toBe(true);
    expect(params[0]).toEqual(["r1", "2026-09-19T00:00:00.000Z", "tok", "120"]);
  });

  it("renews the lease using the deep duration when kind is 'deep'", async () => {
    const params: unknown[][] = [];
    const pool = { query: async (_t: string, v: unknown[] = []) => { params.push(v); return { rowCount: 1 }; } };
    await new RunQueue(pool as never).heartbeat({ runId: "r1", captureId: "c1", pipeline: "minimax", ownerToken: "tok" }, new Date("2026-09-19T00:00:00Z"), "deep");
    expect(params[0]).toEqual(["r1", "2026-09-19T00:00:00.000Z", "tok", "360"]);
  });

  it("renews the lease using the 4-minute enrich duration when kind is 'enrich'", async () => {
    const params: unknown[][] = [];
    const pool = { query: async (_t: string, v: unknown[] = []) => { params.push(v); return { rowCount: 1 }; } };
    await new RunQueue(pool as never).heartbeat({ runId: "r1", captureId: "c1", pipeline: "minimax", ownerToken: "tok" }, new Date("2026-09-19T00:00:00Z"), "enrich");
    expect(params[0]).toEqual(["r1", "2026-09-19T00:00:00.000Z", "tok", "240"]);
  });
});

describe("enqueueEnrichRun", () => {
  it("inserts a queued enrich run with the given capture and pipeline, reporting true", async () => {
    const params: unknown[][] = [];
    const pool = { query: async (_t: string, v: unknown[] = []) => { params.push(v); return { rows: [] }; } };
    await expect(enqueueEnrichRun(pool as never, "cap_1", "mixed")).resolves.toBe(true);
    expect(params[0][1]).toBe("cap_1");
    expect(params[0][2]).toBe("mixed");
  });

  it("swallows a unique_violation (23505) as an already-queued run instead of throwing, reporting false", async () => {
    const pool = { query: async () => { throw Object.assign(new Error("duplicate"), { code: "23505" }); } };
    await expect(enqueueEnrichRun(pool as never, "cap_1", "mixed")).resolves.toBe(false);
  });

  it("rethrows any other error", async () => {
    const pool = { query: async () => { throw new Error("boom"); } };
    await expect(enqueueEnrichRun(pool as never, "cap_1", "mixed")).rejects.toThrow("boom");
  });
});
