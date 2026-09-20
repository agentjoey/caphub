import { describe, expect, it } from "vitest";
import {
  applyOverlap, DEFAULT_THRESHOLD, duplicatePairPrompt, findCandidatePairs, runDuplicateScan, type PairCard
} from "./find-duplicates";

const cardA: PairCard = { id: "cab_a", serial: 1, type: "tool", title: "A 工具", summary: "做 A 的事", tags: ["x"] };
const cardB: PairCard = { id: "cab_b", serial: 2, type: "tool", title: "B 工具", summary: "也做 A 的事", tags: ["x"] };

function fakePairsPool(pairRows: Array<Record<string, unknown>>) {
  const queries: { text: string; values?: unknown[] }[] = [];
  return {
    pool: {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        if (text.includes("FROM caphub_v2.capabilities a")) return { rows: pairRows };
        if (text.startsWith("UPDATE caphub_v2.capabilities SET overlap")) return { rows: [] };
        throw new Error(`unhandled query: ${text}`);
      }
    },
    queries
  };
}

function pairRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    aId: "cab_a", aSerial: 1, aType: "tool", aTitle: "A 工具", aSummary: "做 A 的事", aTags: ["x"],
    bId: "cab_b", bSerial: 2, bType: "tool", bTitle: "B 工具", bSummary: "也做 A 的事", bTags: ["x"],
    similarity: 0.9,
    ...overrides
  };
}

describe("findCandidatePairs", () => {
  it("passes the threshold through to the SQL query, which does the filtering", async () => {
    const { pool, queries } = fakePairsPool([pairRow()]);
    const pairs = await findCandidatePairs(pool as never, 0.85);
    expect(queries[0]?.values).toEqual([0.85]);
    expect(pairs).toEqual([{ a: cardA, b: cardB, similarity: 0.9 }]);
  });

  it("uses the same threshold value main() would default to", () => {
    expect(DEFAULT_THRESHOLD).toBe(0.8);
  });
});

describe("duplicatePairPrompt", () => {
  it("includes both cards' serial codes, titles, summaries, types and tags", () => {
    const prompt = duplicatePairPrompt(cardA, cardB);
    expect(prompt).toContain("TOL-0001");
    expect(prompt).toContain("TOL-0002");
    expect(prompt).toContain("A 工具");
    expect(prompt).toContain("B 工具");
    expect(prompt).toContain("做 A 的事");
    expect(prompt).toContain("也做 A 的事");
  });

  it("falls back to the title when a card has no serial yet", () => {
    const prompt = duplicatePairPrompt({ ...cardA, serial: null }, cardB);
    expect(prompt).toContain("A 工具");
    expect(prompt).not.toContain("TOL-0001");
  });
});

describe("applyOverlap", () => {
  it("writes only the overlap column on the loser card, never status or updated_at", async () => {
    let sql = "";
    let params: unknown[] = [];
    const pool = { query: async (text: string, values: unknown[]) => { sql = text; params = values; return { rows: [] }; } };
    await applyOverlap(pool as never, "cab_b", "duplicate", "TOL-0001", "两者内容重复");
    expect(sql).toContain("SET overlap = $2");
    expect(sql).not.toContain("status");
    expect(sql).not.toContain("updated_at");
    expect(params[0]).toBe("cab_b");
    expect(JSON.parse(params[1] as string)).toEqual({ relation: "duplicate", target: "TOL-0001", reason: "两者内容重复" });
  });
});

describe("runDuplicateScan", () => {
  const log = () => {};

  it("writes overlap on the losing card when relation=duplicate, apply=true", async () => {
    const { pool } = fakePairsPool([pairRow()]);
    const updates: unknown[][] = [];
    const wrappedPool = {
      query: async (text: string, values?: unknown[]) => {
        if (text.startsWith("UPDATE caphub_v2.capabilities SET overlap")) { updates.push(values ?? []); return { rows: [] }; }
        return pool.query(text, values);
      }
    };
    const call = { invoke: async () => ({ value: { relation: "duplicate", keep: "TOL-0001", reason: "重复" } }) };
    const result = await runDuplicateScan(wrappedPool as never, call, true, 0.8, log);
    expect(result).toEqual({
      candidates: 1, written: 1, skippedRelation: 0, failed: 0,
      rows: [{ a: "TOL-0001", b: "TOL-0002", similarity: 0.9, relation: "duplicate", keep: "TOL-0001", reason: "重复" }]
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.[0]).toBe("cab_b"); // B is the loser (A was kept)
    expect(JSON.parse(updates[0]?.[1] as string)).toEqual({ relation: "duplicate", target: "TOL-0001", reason: "重复" });
  });

  it("does not write when apply=false, even for a duplicate pair", async () => {
    const { pool } = fakePairsPool([pairRow()]);
    let updateCalled = false;
    const wrappedPool = {
      query: async (text: string, values?: unknown[]) => {
        if (text.startsWith("UPDATE caphub_v2.capabilities SET overlap")) { updateCalled = true; return { rows: [] }; }
        return pool.query(text, values);
      }
    };
    const call = { invoke: async () => ({ value: { relation: "duplicate", keep: "TOL-0001", reason: "重复" } }) };
    const result = await runDuplicateScan(wrappedPool as never, call, false, 0.8, log);
    expect(result.written).toBe(1);
    expect(updateCalled).toBe(false);
  });

  it("writes nothing and counts skippedRelation for relation=none", async () => {
    const { pool } = fakePairsPool([pairRow()]);
    let updateCalled = false;
    const wrappedPool = {
      query: async (text: string, values?: unknown[]) => {
        if (text.startsWith("UPDATE caphub_v2.capabilities SET overlap")) { updateCalled = true; return { rows: [] }; }
        return pool.query(text, values);
      }
    };
    const call = { invoke: async () => ({ value: { relation: "none", keep: null, reason: "只是语义相近" } }) };
    const result = await runDuplicateScan(wrappedPool as never, call, true, 0.8, log);
    expect(result).toEqual({
      candidates: 1, written: 0, skippedRelation: 1, failed: 0,
      rows: [{ a: "TOL-0001", b: "TOL-0002", similarity: 0.9, relation: "none", keep: null, reason: "只是语义相近" }]
    });
    expect(updateCalled).toBe(false);
  });

  it("writes nothing and counts skippedRelation for relation=complement", async () => {
    const { pool } = fakePairsPool([pairRow()]);
    const call = { invoke: async () => ({ value: { relation: "complement", keep: null, reason: "互补" } }) };
    const result = await runDuplicateScan(pool as never, call, true, 0.8, log);
    expect(result.written).toBe(0);
    expect(result.skippedRelation).toBe(1);
  });

  it("determines the loser as the card NOT named by keep", async () => {
    const { pool } = fakePairsPool([pairRow()]);
    const updates: unknown[][] = [];
    const wrappedPool = {
      query: async (text: string, values?: unknown[]) => {
        if (text.startsWith("UPDATE caphub_v2.capabilities SET overlap")) { updates.push(values ?? []); return { rows: [] }; }
        return pool.query(text, values);
      }
    };
    const call = { invoke: async () => ({ value: { relation: "upgrade", keep: "TOL-0002", reason: "B 更新" } }) };
    await runDuplicateScan(wrappedPool as never, call, true, 0.8, log);
    expect(updates[0]?.[0]).toBe("cab_a"); // A is the loser (B was kept)
  });

  it("rejects a keep value that isn't one of the two offered codes (model hallucination)", async () => {
    const { pool } = fakePairsPool([pairRow()]);
    const call = { invoke: async () => ({ value: { relation: "duplicate", keep: "TOL-9999", reason: "重复" } }) };
    const result = await runDuplicateScan(pool as never, call, true, 0.8, log);
    expect(result.failed).toBe(1);
    expect(result.written).toBe(0);
  });

  it("rejects relation=duplicate with a null keep", async () => {
    const { pool } = fakePairsPool([pairRow()]);
    const call = { invoke: async () => ({ value: { relation: "duplicate", keep: null, reason: "重复" } }) };
    const result = await runDuplicateScan(pool as never, call, true, 0.8, log);
    expect(result.failed).toBe(1);
  });

  it("logs and skips a pair whose model call fails, continuing the scan", async () => {
    const { pool } = fakePairsPool([pairRow(), pairRow({ aId: "cab_c", bId: "cab_d" })]);
    let calls = 0;
    const call = {
      invoke: async () => {
        calls += 1;
        if (calls === 1) throw new Error("deepseek down");
        return { value: { relation: "none", keep: null, reason: "无关" } };
      }
    };
    const logs: Record<string, unknown>[] = [];
    const result = await runDuplicateScan(pool as never, call, true, 0.8, (o) => logs.push(o));
    expect(result.failed).toBe(1);
    expect(result.skippedRelation).toBe(1);
    expect(calls).toBe(2);
    expect(logs.some((l) => typeof l.error === "string")).toBe(true);
  });

  it("calls DeepSeek with a signal that has a timeout (not a bare, never-firing controller)", async () => {
    const { pool } = fakePairsPool([pairRow()]);
    let receivedSignal: AbortSignal | undefined;
    const call = {
      invoke: async (_input: never, signal: AbortSignal) => {
        receivedSignal = signal;
        return { value: { relation: "none", keep: null, reason: "无关" } };
      }
    };
    await runDuplicateScan(pool as never, call, false, 0.8, log);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);
  });

  it("reports 0 candidates when no pair clears the threshold", async () => {
    const { pool } = fakePairsPool([]);
    const call = { invoke: async () => ({ value: { relation: "none", keep: null, reason: "" } }) };
    const result = await runDuplicateScan(pool as never, call, false, 0.8, log);
    expect(result).toEqual({ candidates: 0, written: 0, skippedRelation: 0, failed: 0, rows: [] });
  });
});
