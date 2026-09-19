import { describe, expect, it } from "vitest";
import { listLibrary, listPending, libraryStats, getCapabilityDetail, PAGE_SIZE } from "./queries";

function recorder(rows: unknown[][]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let i = 0;
  return { calls, pool: { query: async (text: string, values: unknown[] = []) => { calls.push({ text, values }); return { rows: rows[i++] ?? [] }; } } as never };
}

describe("library queries", () => {
  it("listPending filters pending, not deleted, newest first, paged", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listPending(pool, { page: 2 });
    expect(calls[0].text).toMatch(/cb\.verdict = 'pending'/);
    expect(calls[0].text).toMatch(/cb\.deleted_at IS NULL/);
    expect(calls[0].text).toMatch(/ORDER BY cb\.created_at DESC/);
    expect(calls[0].values).toEqual([PAGE_SIZE, PAGE_SIZE]);
  });
  it("listLibrary defaults to keep and applies search/type/tag/usage filters as parameters", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool, { q: "web scraping", types: ["skill"], tags: ["python"], usage: "integrate", page: 1 });
    const { text, values } = calls[0];
    expect(text).toMatch(/cb\.verdict = 'keep'/);
    expect(text).toMatch(/websearch_to_tsquery\('simple', \$\d+\)/);
    expect(text).toMatch(/cb\.type = ANY\(\$\d+\)/);
    expect(text).toMatch(/cb\.tags @> \$\d+/);
    expect(text).toMatch(/cb\.usage = \$\d+/);
    expect(values).toEqual(expect.arrayContaining(["web scraping", ["skill"], ["python"], "integrate"]));
  });
  it("listLibrary with discarded=true lists discarded instead of kept", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool, { discarded: true, page: 1 });
    expect(calls[0].text).toMatch(/cb\.verdict = 'discard'/);
  });
  it("libraryStats counts kept by type, distinct tags of kept, and pending", async () => {
    const { pool } = recorder([[{ type: "skill", n: "3" }, { type: "prompt", n: "1" }], [{ n: "7" }], [{ n: "2" }]]);
    const s = await libraryStats(pool);
    expect(s.byType.skill).toBe(3);
    expect(s.byType.experience).toBe(0);
    expect(s.total).toBe(4);
    expect(s.tagCount).toBe(7);
    expect(s.pending).toBe(2);
  });
  it("getCapabilityDetail returns null when missing", async () => {
    const { pool } = recorder([[]]);
    expect(await getCapabilityDetail(pool, "cab_x")).toBeNull();
  });
});
