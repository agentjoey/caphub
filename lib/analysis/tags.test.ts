import { describe, expect, it } from "vitest";
import { bumpTags } from "./tags";

describe("bumpTags", () => {
  it("inserts DISTINCT tag names so ON CONFLICT never touches a row twice", async () => {
    const sql: Array<{ text: string; values: unknown[] }> = [];
    const db = { query: async (text: string, values: unknown[]) => { sql.push({ text, values }); return { rows: [] }; } };
    await bumpTags(db as never, ["rag", "rag"]);
    expect(sql[0].text).toContain("SELECT DISTINCT t, 1 FROM unnest($1::text[]) AS t");
    expect(sql[0].values).toEqual([["rag", "rag"]]);
  });

  it("does nothing for an empty tag list", async () => {
    let called = false;
    await bumpTags({ query: async () => { called = true; return { rows: [] }; } } as never, []);
    expect(called).toBe(false);
  });
});
