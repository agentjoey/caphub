import { describe, expect, it } from "vitest";
import { RunQueue } from "./runs";

function fakePool(claimRow: Record<string, unknown> | undefined) {
  const calls: string[] = [];
  const client = {
    async query(text: string) {
      calls.push(text);
      if (text.includes("UPDATE caphub_v2.analysis_runs r SET state = 'running'")) return { rows: claimRow ? [claimRow] : [], rowCount: claimRow ? 1 : 0 };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  return { calls, pool: { connect: async () => client, query: client.query } as never };
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
});
