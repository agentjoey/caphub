import { describe, expect, it } from "vitest";
import { reviewCapability } from "./review";

describe("reviewCapability", () => {
  it("stores review note without touching verdict", async () => {
    const sql: Array<{ text: string; values: unknown[] }> = [];
    const pool = { query: async (text: string, values: unknown[] = []) => {
      sql.push({ text, values });
      if (text.startsWith("SELECT cb.run_id")) return { rows: [{ run_id: "run_1", card: { title: "t" }, reason_output: { title: "t" } }] };
      return { rows: [] };
    } } as never;
    const call = { provider: "deepseek", model: "d", invoke: async () => ({ value: { agrees: false, points: ["p"] }, usage: { inputTokens: 1, outputTokens: 1 } }) };
    const note = await reviewCapability({ pool, call }, "cab_1", new AbortController().signal);
    expect(note).toEqual({ agrees: false, points: ["p"] });
    const update = sql.find((q) => q.text.startsWith("UPDATE caphub_v2.capabilities SET review_note"))!;
    expect(update.text).not.toMatch(/verdict/);
  });
});
