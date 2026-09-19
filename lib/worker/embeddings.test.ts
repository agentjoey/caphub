import { describe, expect, it } from "vitest";
import { runEmbedTick } from "./embeddings";

function fakePool(selectRows: Array<Record<string, unknown>>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const q = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    if (text.includes("FROM caphub_v2.capabilities")) return { rows: selectRows };
    return { rows: [] };
  };
  return { calls, pool: { query: q } as never };
}

const updatedAt = new Date("2026-01-01T00:00:00Z");

describe("runEmbedTick", () => {
  it("is idle when no capability needs embedding", async () => {
    const { pool } = fakePool([]);
    const embed = { embed: async () => { throw new Error("should not be called"); } };
    expect(await runEmbedTick({ pool, embed }, new AbortController().signal)).toBe("idle");
  });

  it("embeds candidates in one batch call and writes vectors guarded by updated_at", async () => {
    const rows = [
      { id: "cab_1", title: "T1", summary: "S1", tags: ["a"], updated_at: updatedAt, label_zh: ["视频"], label_en: ["Video"] },
      { id: "cab_2", title: "T2", summary: "S2", tags: [], updated_at: updatedAt, label_zh: [], label_en: [] }
    ];
    const { pool, calls } = fakePool(rows);
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
    expect(updates[0].values).toEqual(["cab_1", "[" + Array(768).fill(0.1).join(",") + "]", updatedAt, updatedAt]);
    expect(updates[1].values[0]).toBe("cab_2");
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

  it("never includes texts or an api key in the failure log", async () => {
    const rows = [{ id: "cab_1", title: "SECRET TITLE", summary: "S1", tags: [], updated_at: updatedAt, label_zh: [], label_en: [] }];
    const { pool } = fakePool(rows);
    const embed = { embed: async () => { throw Object.assign(new Error("nope"), { code: "UNAVAILABLE" }); } };
    const logs: Record<string, unknown>[] = [];
    await runEmbedTick({ pool, embed, log: (o) => logs.push(o) }, new AbortController().signal);
    expect(JSON.stringify(logs)).not.toMatch(/SECRET TITLE/);
  });
});
