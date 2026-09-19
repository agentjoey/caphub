import { describe, expect, it } from "vitest";
import { runEmbedTick } from "./embeddings";

function fakePool(selectRows: Array<Record<string, unknown>>, updateRowCounts: number[] = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let updateIndex = 0;
  const q = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    if (text.includes("FROM caphub_v2.capabilities")) return { rows: selectRows };
    if (text.includes("UPDATE caphub_v2.capabilities SET embedding")) {
      const rowCount = updateRowCounts[updateIndex] ?? 1;
      updateIndex += 1;
      return { rows: [], rowCount };
    }
    return { rows: [] };
  };
  return { calls, pool: { query: q } as never };
}

const updatedAt = new Date("2026-01-01T00:00:00.123Z");

describe("runEmbedTick", () => {
  it("is idle when no capability needs embedding", async () => {
    const { pool } = fakePool([]);
    const embed = { embed: async () => { throw new Error("should not be called"); } };
    expect(await runEmbedTick({ pool, embed }, new AbortController().signal)).toBe("idle");
  });

  it("embeds candidates in one batch call and writes vectors guarded by a ms-truncated updated_at", async () => {
    const rows = [
      { id: "cab_1", title: "T1", summary: "S1", tags: ["a"], updated_at: updatedAt, label_zh: ["视频"], label_en: ["Video"] },
      { id: "cab_2", title: "T2", summary: "S2", tags: [], updated_at: updatedAt, label_zh: [], label_en: [] }
    ];
    const { pool, calls } = fakePool(rows, [1, 1]);
    const seenTexts: string[][] = [];
    const embed = {
      embed: async (texts: string[]) => { seenTexts.push(texts); return texts.map(() => Array(768).fill(0.1)); }
    };
    const result = await runEmbedTick({ pool, embed }, new AbortController().signal);
    expect(result).toBe("embedded");
    expect(seenTexts).toHaveLength(1);
    expect(seenTexts[0]).toEqual(["T1\nS1\n标签: a\n场景: 视频, Video", "T2\nS2"]);
    const updates = calls.filter((c) => c.text.includes("UPDATE caphub_v2.capabilities SET embedding"));
    expect(updates).toHaveLength(2);
    // The guard must compare a ms-truncated updated_at, not the raw µs-precision value, since
    // node-postgres reads timestamptz back at millisecond precision (see lib/library/actions.ts).
    expect(updates[0].text).toMatch(/date_trunc\('milliseconds', updated_at\) = \$3::timestamptz/);
    expect(updates[0].text).not.toMatch(/updated_at = \$4/);
    // embedded_at must be set from the row's own updated_at column, not a bound parameter,
    // so embedded_at < updated_at reads false immediately after a successful write.
    expect(updates[0].text).toMatch(/embedded_at = updated_at/);
    expect(updates[0].values).toEqual(["cab_1", "[" + Array(768).fill(0.1).join(",") + "]", updatedAt]);
    expect(updates[1].values[0]).toBe("cab_2");
  });

  it("logs written/skipped counts from rowCount and returns 'idle' when every write is a stale no-op", async () => {
    const rows = [
      { id: "cab_1", title: "T1", summary: "S1", tags: [], updated_at: updatedAt, label_zh: [], label_en: [] },
      { id: "cab_2", title: "T2", summary: "S2", tags: [], updated_at: updatedAt, label_zh: [], label_en: [] }
    ];
    const { pool } = fakePool(rows, [0, 0]);
    const embed = { embed: async (texts: string[]) => texts.map(() => Array(768).fill(0.1)) };
    const logs: Record<string, unknown>[] = [];
    const result = await runEmbedTick({ pool, embed, log: (o) => logs.push(o) }, new AbortController().signal);
    expect(result).toBe("idle");
    expect(logs).toContainEqual({ embed: "done", written: 0, skipped: 2 });
  });

  it("counts only rows actually written when one update is a stale no-op", async () => {
    const rows = [
      { id: "cab_1", title: "T1", summary: "S1", tags: [], updated_at: updatedAt, label_zh: [], label_en: [] },
      { id: "cab_2", title: "T2", summary: "S2", tags: [], updated_at: updatedAt, label_zh: [], label_en: [] }
    ];
    const { pool } = fakePool(rows, [1, 0]);
    const embed = { embed: async (texts: string[]) => texts.map(() => Array(768).fill(0.1)) };
    const logs: Record<string, unknown>[] = [];
    const result = await runEmbedTick({ pool, embed, log: (o) => logs.push(o) }, new AbortController().signal);
    expect(result).toBe("embedded");
    expect(logs).toContainEqual({ embed: "done", written: 1, skipped: 1 });
  });

  it("logs a per-row failure and keeps counting other rows' writes instead of losing the count", async () => {
    const rows = [
      { id: "cab_1", title: "T1", summary: "S1", tags: [], updated_at: updatedAt, label_zh: [], label_en: [] },
      { id: "cab_2", title: "T2", summary: "S2", tags: [], updated_at: updatedAt, label_zh: [], label_en: [] }
    ];
    const calls: Array<{ text: string; values: unknown[] }> = [];
    let updateCount = 0;
    const q = async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("FROM caphub_v2.capabilities")) return { rows };
      if (text.includes("UPDATE caphub_v2.capabilities SET embedding")) {
        updateCount += 1;
        if (updateCount === 1) throw Object.assign(new Error("db down"), { code: "UNAVAILABLE" });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    };
    const pool = { query: q } as never;
    const embed = { embed: async (texts: string[]) => texts.map(() => Array(768).fill(0.1)) };
    const logs: Record<string, unknown>[] = [];
    const result = await runEmbedTick({ pool, embed, log: (o) => logs.push(o) }, new AbortController().signal);
    expect(result).toBe("embedded");
    expect(logs).toContainEqual({ embed: "row-failed", capability: "cab_1", code: "UNAVAILABLE" });
    expect(logs).toContainEqual({ embed: "done", written: 1, skipped: 1 });
  });

  it("returns 'error' and logs a short message without throwing when the embed call fails", async () => {
    const rows = [{ id: "cab_1", title: "T1", summary: "S1", tags: [], updated_at: updatedAt, label_zh: [], label_en: [] }];
    const { pool, calls } = fakePool(rows);
    const embed = { embed: async () => { throw Object.assign(new Error("nope"), { code: "TIMEOUT" }); } };
    const logs: Record<string, unknown>[] = [];
    const result = await runEmbedTick({ pool, embed, log: (o) => logs.push(o) }, new AbortController().signal);
    expect(result).toBe("error");
    expect(logs).toEqual([{ embed: "failed", code: "TIMEOUT" }]);
    expect(calls.some((c) => c.text.includes("UPDATE caphub_v2.capabilities SET embedding"))).toBe(false);
  });

  it("falls back to embedding one row at a time when the batch call fails with INVALID_OUTPUT, so one bad text can't block the rest", async () => {
    const rows = [
      { id: "cab_1", title: "BAD", summary: "S1", tags: [], updated_at: updatedAt, label_zh: [], label_en: [] },
      { id: "cab_2", title: "GOOD", summary: "S2", tags: [], updated_at: updatedAt, label_zh: [], label_en: [] }
    ];
    const { pool, calls } = fakePool(rows, [1]);
    const seenBatches: string[][] = [];
    const embed = {
      embed: async (texts: string[]) => {
        seenBatches.push(texts);
        if (texts.length > 1) throw Object.assign(new Error("bad request"), { code: "INVALID_OUTPUT" });
        if (texts[0]!.includes("BAD")) throw Object.assign(new Error("bad request"), { code: "INVALID_OUTPUT" });
        return texts.map(() => Array(768).fill(0.2));
      }
    };
    const logs: Record<string, unknown>[] = [];
    const result = await runEmbedTick({ pool, embed, log: (o) => logs.push(o) }, new AbortController().signal);
    expect(result).toBe("embedded");
    // One batch attempt, then one call per row.
    expect(seenBatches).toHaveLength(3);
    expect(seenBatches[1]).toHaveLength(1);
    expect(seenBatches[2]).toHaveLength(1);
    const updates = calls.filter((c) => c.text.includes("UPDATE caphub_v2.capabilities SET embedding"));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.values[0]).toBe("cab_2");
    expect(logs).toContainEqual({ embed: "batch-failed", code: "INVALID_OUTPUT", fallback: "per-row" });
    expect(logs).toContainEqual({ embed: "row-embed-failed", capability: "cab_1", code: "INVALID_OUTPUT" });
    expect(logs).toContainEqual({ embed: "done", written: 1, skipped: 1 });
    // Never logs the offending text.
    expect(JSON.stringify(logs)).not.toMatch(/BAD/);
  });

  it("returns 'error' (not 'idle') when every row in an INVALID_OUTPUT fallback batch fails to embed, so the caller's backoff isn't reset for a poison row", async () => {
    const rows = [{ id: "cab_poison", title: "BAD", summary: "S1", tags: [], updated_at: updatedAt, label_zh: [], label_en: [] }];
    const { pool, calls } = fakePool(rows);
    const embed = {
      embed: async () => {
        throw Object.assign(new Error("bad request"), { code: "INVALID_OUTPUT" });
      }
    };
    const logs: Record<string, unknown>[] = [];
    const result = await runEmbedTick({ pool, embed, log: (o) => logs.push(o) }, new AbortController().signal);
    expect(result).toBe("error");
    expect(logs).toContainEqual({ embed: "row-embed-failed", capability: "cab_poison", code: "INVALID_OUTPUT" });
    expect(logs).toContainEqual({ embed: "done", written: 0, skipped: 1 });
    expect(calls.some((c) => c.text.includes("UPDATE caphub_v2.capabilities SET embedding"))).toBe(false);
  });

  it("returns 'embedded' when a mixed INVALID_OUTPUT fallback batch writes at least one row", async () => {
    const rows = [
      { id: "cab_1", title: "BAD", summary: "S1", tags: [], updated_at: updatedAt, label_zh: [], label_en: [] },
      { id: "cab_2", title: "GOOD", summary: "S2", tags: [], updated_at: updatedAt, label_zh: [], label_en: [] }
    ];
    const { pool } = fakePool(rows, [1]);
    const embed = {
      embed: async (texts: string[]) => {
        if (texts.length > 1) throw Object.assign(new Error("bad request"), { code: "INVALID_OUTPUT" });
        if (texts[0]!.includes("BAD")) throw Object.assign(new Error("bad request"), { code: "INVALID_OUTPUT" });
        return texts.map(() => Array(768).fill(0.2));
      }
    };
    const logs: Record<string, unknown>[] = [];
    const result = await runEmbedTick({ pool, embed, log: (o) => logs.push(o) }, new AbortController().signal);
    expect(result).toBe("embedded");
    expect(logs).toContainEqual({ embed: "row-embed-failed", capability: "cab_1", code: "INVALID_OUTPUT" });
    expect(logs).toContainEqual({ embed: "done", written: 1, skipped: 1 });
  });

  it("still returns 'error' without a per-row fallback for a transient batch failure (e.g. TIMEOUT)", async () => {
    const rows = [{ id: "cab_1", title: "T1", summary: "S1", tags: [], updated_at: updatedAt, label_zh: [], label_en: [] }];
    const { pool } = fakePool(rows);
    let calls = 0;
    const embed = { embed: async () => { calls += 1; throw Object.assign(new Error("timeout"), { code: "TIMEOUT" }); } };
    const result = await runEmbedTick({ pool, embed }, new AbortController().signal);
    expect(result).toBe("error");
    expect(calls).toBe(1);
  });

  it("never includes texts or an api key in the failure log", async () => {
    const rows = [{ id: "cab_1", title: "SECRET TITLE", summary: "S1", tags: [], updated_at: updatedAt, label_zh: [], label_en: [] }];
    const { pool } = fakePool(rows);
    const embed = { embed: async () => { throw Object.assign(new Error("nope"), { code: "UNAVAILABLE" }); } };
    const logs: Record<string, unknown>[] = [];
    await runEmbedTick({ pool, embed, log: (o) => logs.push(o) }, new AbortController().signal);
    expect(JSON.stringify(logs)).not.toMatch(/SECRET TITLE/);
  });
});
