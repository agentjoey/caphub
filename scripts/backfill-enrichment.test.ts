import { describe, expect, it } from "vitest";
import { ESTIMATED_CALLS_PER_CARD, loadCandidates, runBackfill } from "./backfill-enrichment";

function fakeCandidatesPool(rows: Array<Record<string, unknown>>) {
  const calls: { text: string; values: unknown[] }[] = [];
  const pool = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("FROM caphub_v2.capabilities")) return { rows };
      throw new Error(`unhandled query: ${text}`);
    }
  };
  return { pool, calls };
}

const rowA = { captureId: "cap_a", serial: 3, type: "skill" as const, title: "Card A", pipeline: "mixed" as const };
const rowB = { captureId: "cap_b", serial: 12, type: "tool" as const, title: "Card B", pipeline: "minimax" as const };

describe("loadCandidates", () => {
  it("selects keep/active/non-deleted/never-enriched cards ordered oldest first", async () => {
    const { pool, calls } = fakeCandidatesPool([rowA, rowB]);
    const rows = await loadCandidates(pool as never);
    expect(rows).toEqual([rowA, rowB]);
    const sql = calls[0]?.text ?? "";
    expect(sql).toContain("verdict = 'keep'");
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("deleted_at IS NULL");
    expect(sql).toContain("enriched_at IS NULL");
    expect(sql).toContain("ORDER BY cb.created_at");
  });

  it("respects an optional limit, passed as a query parameter", async () => {
    const { pool, calls } = fakeCandidatesPool([rowA]);
    await loadCandidates(pool as never, 1);
    expect(calls[0]?.text).toContain("LIMIT $1");
    expect(calls[0]?.values).toEqual([1]);
  });

  it("omits LIMIT entirely when no limit is given", async () => {
    const { pool, calls } = fakeCandidatesPool([rowA, rowB]);
    await loadCandidates(pool as never);
    expect(calls[0]?.text).not.toContain("LIMIT");
    expect(calls[0]?.values).toEqual([]);
  });
});

describe("runBackfill", () => {
  const log = () => {};

  it("dry-run (apply=false) enqueues nothing and reports the candidates and estimated call count", async () => {
    const { pool } = fakeCandidatesPool([rowA, rowB]);
    const enqueued: unknown[] = [];
    const enqueue = async (_p: unknown, captureId: string, pipeline: string) => { enqueued.push({ captureId, pipeline }); };
    const result = await runBackfill(pool as never, enqueue, false, undefined, log);
    expect(enqueued).toEqual([]);
    expect(result).toEqual({
      candidates: [rowA, rowB], queued: 0, alreadyQueued: 0, failed: 0,
      estimatedCalls: 2 * ESTIMATED_CALLS_PER_CARD
    });
  });

  it("--apply calls the injected enqueue helper once per candidate with its captureId and pipeline", async () => {
    const { pool } = fakeCandidatesPool([rowA, rowB]);
    const enqueued: unknown[] = [];
    const enqueue = async (_p: unknown, captureId: string, pipeline: string) => { enqueued.push({ captureId, pipeline }); };
    const result = await runBackfill(pool as never, enqueue, true, undefined, log);
    expect(enqueued).toEqual([
      { captureId: "cap_a", pipeline: "mixed" },
      { captureId: "cap_b", pipeline: "minimax" }
    ]);
    expect(result.queued).toBe(2);
    expect(result.alreadyQueued).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("counts a 23505 (unique_violation) as already-queued, not a failure", async () => {
    const { pool } = fakeCandidatesPool([rowA, rowB]);
    const enqueue = async (_p: unknown, captureId: string) => {
      if (captureId === "cap_a") throw Object.assign(new Error("duplicate"), { code: "23505" });
    };
    const result = await runBackfill(pool as never, enqueue, true, undefined, log);
    expect(result.queued).toBe(1);
    expect(result.alreadyQueued).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("a failing row does not abort the rest of the batch", async () => {
    const { pool } = fakeCandidatesPool([rowA, rowB]);
    const enqueue = async (_p: unknown, captureId: string) => {
      if (captureId === "cap_a") throw new Error("boom");
    };
    const result = await runBackfill(pool as never, enqueue, true, undefined, log);
    expect(result.queued).toBe(1);
    expect(result.alreadyQueued).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("respects --limit by only loading that many candidates", async () => {
    const { pool, calls } = fakeCandidatesPool([rowA]);
    const result = await runBackfill(pool as never, async () => {}, false, 1, log);
    expect(calls[0]?.values).toEqual([1]);
    expect(result.candidates).toEqual([rowA]);
  });
});
