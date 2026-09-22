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
  it("treats a text capture with null/empty-string legacy prompt as having no verifiable source", () => {
    const row = { ...base, capture_kind: "text" as const, capture_text: "some text", playbook: { kind: "integrate", install: [], repo: null, prompt_text: null } };
    expect(pickBackfill(row)).toEqual({ unresolved: "no verifiable source for a text capture" });
    const rowEmpty = { ...row, playbook: { ...row.playbook, prompt_text: "" } };
    expect(pickBackfill(rowEmpty)).toEqual({ unresolved: "no verifiable source for a text capture" });
  });
  it("tolerates a non-array vision_output.prompts and falls back to prompt_text", () => {
    const visionNonArray = { ...base, vision_output: { prompts: "not an array" as never, prompt_text: "fallback" } };
    expect(pickBackfill(visionNonArray)).toEqual({ prompts: ["fallback"] });
    const visionNull = { ...base, vision_output: { prompts: null as never, prompt_text: "also fallback" } };
    expect(pickBackfill(visionNull)).toEqual({ prompts: ["also fallback"] });
  });

  it("flags maybeMultiple when the old single-string prompt_text contains a blank line", () => {
    const row = { ...base, vision_output: { prompt_text: "第一条提示词\n\n第二条提示词" } };
    expect(pickBackfill(row)).toEqual({ prompts: ["第一条提示词\n\n第二条提示词"], maybeMultiple: true });
  });

  it("does not flag maybeMultiple when the old prompt_text has no blank line", () => {
    const row = { ...base, vision_output: { prompt_text: "一条完整的提示词，没有空行" } };
    expect(pickBackfill(row)).toEqual({ prompts: ["一条完整的提示词，没有空行"] });
  });

  it("does not flag maybeMultiple for the new-format prompts array, even with a blank line inside an item", () => {
    const row = { ...base, vision_output: { prompts: ["第一条\n\n仍是第一条的一部分"] } };
    expect(pickBackfill(row)).toEqual({ prompts: ["第一条\n\n仍是第一条的一部分"] });
  });

  it("does not flag maybeMultiple for a legacy text-capture playbook prompt", () => {
    const row = { ...base, capture_kind: "text" as const, capture_text: "前言 你好\n\n世界 后记", playbook: { kind: "integrate", install: [], repo: null, prompt_text: "你好\n\n世界" } };
    expect(pickBackfill(row)).toEqual({ prompts: ["你好\n\n世界"] });
  });
});

describe("runPromptBackfill", () => {
  function fakePool(rows: BackfillRow[], updateRowCounts: number[] = []) {
    const writes: Array<{ text: string; values: unknown[] }> = [];
    let updateCount = 0;
    return {
      writes,
      pool: { query: async (text: string, values: unknown[] = []) => {
        if (text.trimStart().startsWith("SELECT")) return { rows };
        writes.push({ text, values });
        const rowCount = updateRowCounts[updateCount] ?? 1;
        updateCount += 1;
        return { rows: [], rowCount };
      } }
    };
  }

  it("writes nothing in dry-run", async () => {
    const { pool, writes } = fakePool([{ ...base, vision_output: { prompt_text: "原文" } }]);
    const out = await runPromptBackfill(pool as never, false, () => {});
    expect(out).toEqual({ candidates: 1, filled: 1, unresolved: 0, skipped: 0, moved: 0 });
    expect(writes).toHaveLength(0);
  });

  it("fills prompts, strips playbook.prompt_text and guards on an empty prompts column when applying", async () => {
    const { pool, writes } = fakePool([{ ...base, vision_output: { prompt_text: "原文" } }, { ...base, id: "cab_2" }]);
    const out = await runPromptBackfill(pool as never, true, () => {});
    expect(out).toEqual({ candidates: 2, filled: 1, unresolved: 1, skipped: 0, moved: 0 });
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain("playbook - 'prompt_text'");
    expect(writes[0].text).toContain("prompts = '[]'::jsonb");
    expect(writes[0].text).not.toContain("updated_at");
    expect(writes[0].values).toEqual(["cab_1", JSON.stringify([{ text: "原文" }])]);
  });

  it("detects when a concurrent rerun already set prompts (rowCount = 0) and counts as skipped", async () => {
    const { pool, writes } = fakePool([{ ...base, vision_output: { prompt_text: "原文" } }], [0]);
    const out = await runPromptBackfill(pool as never, true, () => {});
    expect(out).toEqual({ candidates: 1, filled: 0, unresolved: 0, skipped: 1, moved: 0 });
    expect(writes).toHaveLength(1);
  });

  it("migrates a non-prompt card's unresolved legacy prompt_text into playbook.usage_prompt instead of leaving it unresolved", async () => {
    const row: BackfillRow = {
      ...base, type: "skill", capture_kind: "text", capture_text: "unrelated text",
      playbook: { kind: "integrate", install: [], repo: null, prompt_text: "not verbatim in capture" }, vision_output: null
    };
    const { pool, writes } = fakePool([row]);
    const out = await runPromptBackfill(pool as never, true, () => {});
    expect(out).toEqual({ candidates: 1, filled: 0, unresolved: 0, skipped: 0, moved: 1 });
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain("playbook = (playbook - 'prompt_text') || jsonb_build_object('usage_prompt', playbook->'prompt_text')");
    expect(writes[0].text).toContain("playbook ? 'prompt_text'");
    expect(writes[0].text).not.toContain("prompts =");
    expect(writes[0].text).not.toContain("updated_at");
    expect(writes[0].values).toEqual(["cab_1"]);
  });

  it("does not write anything for a migrated card in dry-run, but still counts it as moved", async () => {
    const row: BackfillRow = {
      ...base, type: "skill", capture_kind: "text", capture_text: "unrelated text",
      playbook: { kind: "integrate", install: [], repo: null, prompt_text: "not verbatim in capture" }, vision_output: null
    };
    const { pool, writes } = fakePool([row]);
    const out = await runPromptBackfill(pool as never, false, () => {});
    expect(out).toEqual({ candidates: 1, filled: 0, unresolved: 0, skipped: 0, moved: 1 });
    expect(writes).toHaveLength(0);
  });

  it("logs movedToUsagePrompt: true for a migrated card", async () => {
    const row: BackfillRow = {
      ...base, type: "skill", capture_kind: "text", capture_text: "unrelated text",
      playbook: { kind: "integrate", install: [], repo: null, prompt_text: "not verbatim in capture" }, vision_output: null
    };
    const { pool } = fakePool([row]);
    const logs: Array<Record<string, unknown>> = [];
    await runPromptBackfill(pool as never, true, (o) => logs.push(o));
    const entry = logs.find((l) => l.capabilityId === "cab_1" && l.movedToUsagePrompt === true);
    expect(entry).toMatchObject({ capabilityId: "cab_1", serial: 27, type: "skill", movedToUsagePrompt: true, applied: true });
  });

  it("leaves a prompt-type card with no verifiable source as unresolved, not migrated", async () => {
    const row: BackfillRow = {
      ...base, type: "prompt", capture_kind: "image", playbook: { kind: "reference", points: ["p"] }, vision_output: null
    };
    const { pool, writes } = fakePool([row]);
    const out = await runPromptBackfill(pool as never, true, () => {});
    expect(out).toEqual({ candidates: 1, filled: 0, unresolved: 1, skipped: 0, moved: 0 });
    expect(writes).toHaveLength(0);
  });

  it("logs the legacy playbook.prompt_text and capture_kind for an unresolved row", async () => {
    const row: BackfillRow = { ...base, capture_kind: "text", capture_text: "unrelated text", playbook: { kind: "integrate", install: [], repo: null, prompt_text: "not verbatim in capture" }, vision_output: null };
    const { pool } = fakePool([row]);
    const logs: Array<Record<string, unknown>> = [];
    await runPromptBackfill(pool as never, false, (o) => logs.push(o));
    const entry = logs.find((l) => l.capabilityId === "cab_1");
    expect(entry).toMatchObject({
      unresolved: "text capture, playbook prompt not verbatim in source",
      legacyPromptText: "not verbatim in capture",
      captureKind: "text"
    });
  });

  it("logs legacyPromptText: null when the row has no legacy playbook prompt at all", async () => {
    const row: BackfillRow = { ...base, capture_kind: "image", playbook: { kind: "reference", points: ["p"] }, vision_output: null };
    const { pool } = fakePool([row]);
    const logs: Array<Record<string, unknown>> = [];
    await runPromptBackfill(pool as never, false, (o) => logs.push(o));
    const entry = logs.find((l) => l.capabilityId === "cab_1");
    expect(entry).toMatchObject({ legacyPromptText: null, captureKind: "image" });
  });

  it("logs maybeMultiple: true for a filled row picked from an old prompt_text with a blank line", async () => {
    const row: BackfillRow = { ...base, vision_output: { prompt_text: "第一条\n\n第二条" } };
    const { pool } = fakePool([row]);
    const logs: Array<Record<string, unknown>> = [];
    await runPromptBackfill(pool as never, false, (o) => logs.push(o));
    const entry = logs.find((l) => l.capabilityId === "cab_1");
    expect(entry).toMatchObject({ maybeMultiple: true, prompts: ["第一条\n\n第二条"] });
  });

  it("omits maybeMultiple for a filled row with no blank-line heuristic hit", async () => {
    const row: BackfillRow = { ...base, vision_output: { prompt_text: "一条完整提示词" } };
    const { pool } = fakePool([row]);
    const logs: Array<Record<string, unknown>> = [];
    await runPromptBackfill(pool as never, false, (o) => logs.push(o));
    const entry = logs.find((l) => l.capabilityId === "cab_1");
    expect(entry).not.toHaveProperty("maybeMultiple");
  });

  it("candidate SQL filters to only cards with non-empty legacy prompt_text or type=prompt", async () => {
    let candidatesSql = "";
    const { pool } = fakePool([]);
    pool.query = async (text: string) => {
      if (text.trimStart().startsWith("SELECT")) candidatesSql = text;
      return { rows: [] };
    };
    await runPromptBackfill(pool as never, false, () => {});
    expect(candidatesSql).toContain("coalesce(cb.playbook->>'prompt_text', '') <> ''");
    expect(candidatesSql).not.toContain("cb.playbook ? 'prompt_text'");
  });

  it("vision output subquery filters to only steps with actual prompt content, using CASE guard for safety", async () => {
    let candidatesSql = "";
    const { pool } = fakePool([]);
    pool.query = async (text: string) => {
      if (text.trimStart().startsWith("SELECT")) candidatesSql = text;
      return { rows: [] };
    };
    await runPromptBackfill(pool as never, false, () => {});
    expect(candidatesSql).toContain("CASE WHEN jsonb_typeof(s.output->'prompts') = 'array' THEN jsonb_array_length(s.output->'prompts') > 0 ELSE false END");
    expect(candidatesSql).toContain("coalesce(s.output->>'prompt_text', '') <> ''");
  });
});
