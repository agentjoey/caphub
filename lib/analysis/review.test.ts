import { describe, expect, it } from "vitest";
import { PROMPTS_STORED_SEPARATELY } from "./prompts";
import { reviewCapability } from "./review";

function makePool(rows: { run_id?: string; card?: unknown; reason_output?: unknown } | null) {
  const sql: Array<{ text: string; values: unknown[] }> = [];
  const pool = { query: async (text: string, values: unknown[] = []) => {
    sql.push({ text, values });
    if (text.startsWith("SELECT cb.run_id")) return { rows: rows ? [rows] : [] };
    return { rows: [] };
  } } as never;
  return { pool, sql };
}

describe("reviewCapability", () => {
  it("stores review note without touching verdict or the updated_at lock token", async () => {
    const { pool, sql } = makePool({ run_id: "run_1", card: { title: "t" }, reason_output: { title: "t" } });
    const call = { provider: "deepseek", model: "d", invoke: async () => ({ value: { agrees: false, points: ["p"] }, usage: { inputTokens: 1, outputTokens: 1 } }) };
    const note = await reviewCapability({ pool, call }, "cab_1", new AbortController().signal);
    expect(note).toEqual({ agrees: false, points: ["p"] });
    const update = sql.find((q) => q.text.startsWith("UPDATE caphub_v2.capabilities SET review_note"))!;
    expect(update.text).not.toMatch(/verdict/);
    expect(update.text).not.toMatch(/updated_at/);
    expect(update.values).toEqual(["cab_1", JSON.stringify({ agrees: false, points: ["p"] })]);
  });

  it("includes summary_points in the card object handed to the reviewer, so it can judge whether summary omits/exaggerates against the full structured summary, not just the ~120-char lead", async () => {
    const { pool, sql } = makePool({ run_id: "run_1", card: { title: "t" }, reason_output: { title: "t" } });
    const call = { provider: "deepseek", model: "d", invoke: async () => ({ value: { agrees: true, points: [] }, usage: { inputTokens: 1, outputTokens: 1 } }) };
    await reviewCapability({ pool, call }, "cab_1", new AbortController().signal);
    const select = sql.find((q) => q.text.startsWith("SELECT cb.run_id"))!;
    expect(select.text).toMatch(/'summary_points', cb\.summary_points/);
  });

  it("throws CAPABILITY_NOT_FOUND when the capability row is missing", async () => {
    const { pool } = makePool(null);
    const call = { provider: "deepseek", model: "d", invoke: async () => { throw new Error("should not be called"); } };
    await expect(reviewCapability({ pool, call }, "cab_missing", new AbortController().signal))
      .rejects.toMatchObject({ code: "CAPABILITY_NOT_FOUND" });
  });

  it("throws REASON_STEP_NOT_FOUND when there is no ok reason step, without calling the model", async () => {
    const { pool } = makePool({ run_id: "run_1", card: { title: "t" }, reason_output: null });
    let called = false;
    const call = { provider: "deepseek", model: "d", invoke: async () => { called = true; return { value: { agrees: true, points: [] }, usage: { inputTokens: 1, outputTokens: 1 } }; } };
    await expect(reviewCapability({ pool, call }, "cab_1", new AbortController().signal))
      .rejects.toMatchObject({ code: "REASON_STEP_NOT_FOUND" });
    expect(called).toBe(false);
  });

  it("sends only the whitelisted card fields to the model, never verdict/internal fields", async () => {
    const { pool } = makePool({ run_id: "run_1", card: { title: "t" }, reason_output: { title: "t" } });
    let seenPrompt = "";
    const call = { provider: "deepseek", model: "d", invoke: async (input: { prompt: string }) => {
      seenPrompt = input.prompt;
      return { value: { agrees: true, points: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    await reviewCapability({ pool, call }, "cab_1", new AbortController().signal);
    expect(seenPrompt).not.toMatch(/verdict_by/);
    expect(seenPrompt).not.toMatch(/notified_at/);
  });

  it("tells the reviewer prompts are stored separately, so a missing playbook prompt isn't marked down or raised as an open question", async () => {
    const { pool } = makePool({ run_id: "run_1", card: { title: "t" }, reason_output: { title: "t" } });
    let seenPrompt = "";
    const call = { provider: "deepseek", model: "d", invoke: async (input: { prompt: string }) => {
      seenPrompt = input.prompt;
      return { value: { agrees: true, points: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    await reviewCapability({ pool, call }, "cab_1", new AbortController().signal);
    expect(seenPrompt).toContain(PROMPTS_STORED_SEPARATELY);
  });
});
