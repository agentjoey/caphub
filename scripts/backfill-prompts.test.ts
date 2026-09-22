import { describe, expect, it } from "vitest";
import { pickBackfill, runPromptBackfill, type BackfillRow } from "./backfill-prompts";

const base: BackfillRow = { id: "cab_1", serial: 27, type: "prompt", playbook: { kind: "reference", points: ["p"] }, capture_kind: "image", capture_text: null, vision_output: null };

describe("pickBackfill", () => {
  it("prefers the new-format vision prompts", () => {
    expect(pickBackfill({ ...base, vision_output: { prompts: ["A", "B"] } })).toEqual({ prompts: ["A", "B"] });
  });
  it("falls back to the old-format vision prompt_text", () => {
    expect(pickBackfill({ ...base, vision_output: { prompt_text: "原文" } })).toEqual({ prompts: ["原文"] });
  });
  it("accepts a text capture's playbook prompt only when it appears verbatim in the capture", () => {
    const row = { ...base, capture_kind: "text" as const, capture_text: "前言 你是助手。 后记", playbook: { kind: "integrate", install: [], repo: null, prompt_text: "你是助手。" } };
    expect(pickBackfill(row)).toEqual({ prompts: ["你是助手。"] });
    expect(pickBackfill({ ...row, playbook: { ...row.playbook, prompt_text: "改写过的" } })).toEqual({ unresolved: "text capture, playbook prompt not verbatim in source" });
  });
  it("reports an image card with no transcription as unresolved", () => {
    expect(pickBackfill({ ...base, vision_output: { prompt_text: null } })).toEqual({ unresolved: "no vision transcription" });
  });
});

describe("runPromptBackfill", () => {
  function fakePool(rows: BackfillRow[]) {
    const writes: Array<{ text: string; values: unknown[] }> = [];
    return {
      writes,
      pool: { query: async (text: string, values: unknown[] = []) => {
        if (text.trimStart().startsWith("SELECT")) return { rows };
        writes.push({ text, values });
        return { rows: [], rowCount: 1 };
      } }
    };
  }

  it("writes nothing in dry-run", async () => {
    const { pool, writes } = fakePool([{ ...base, vision_output: { prompt_text: "原文" } }]);
    const out = await runPromptBackfill(pool as never, false, () => {});
    expect(out).toEqual({ candidates: 1, filled: 1, unresolved: 0 });
    expect(writes).toHaveLength(0);
  });

  it("fills prompts, strips playbook.prompt_text and guards on an empty prompts column when applying", async () => {
    const { pool, writes } = fakePool([{ ...base, vision_output: { prompt_text: "原文" } }, { ...base, id: "cab_2" }]);
    const out = await runPromptBackfill(pool as never, true, () => {});
    expect(out).toEqual({ candidates: 2, filled: 1, unresolved: 1 });
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain("playbook - 'prompt_text'");
    expect(writes[0].text).toContain("prompts = '[]'::jsonb");
    expect(writes[0].text).not.toContain("updated_at");
    expect(writes[0].values).toEqual(["cab_1", JSON.stringify([{ text: "原文" }])]);
  });
});
