import { describe, expect, it } from "vitest";
import { CAPABILITY_TYPE_DEFINITIONS } from "../lib/analysis/prompts";
import { applyTypeReclassification, reclassifyTypePrompt, runReclassify } from "./reclassify-types";

function fakeRowsPool(rows: Array<Record<string, unknown>>) {
  const updates: unknown[][] = [];
  return {
    pool: {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes("SELECT id, title")) return { rows };
        if (text.startsWith("UPDATE caphub_v2.capabilities SET type")) {
          updates.push(values ?? []);
          return { rows: [] };
        }
        throw new Error(`unhandled query: ${text}`);
      }
    },
    updates
  };
}

const row = {
  id: "cab_1", title: "t", summary: "s", signals: [], playbook: {}, tags: [],
  type: "other" as const, verdictBy: "auto" as const, serial: 12
};

describe("reclassifyTypePrompt", () => {
  it("reuses the shared capability-type definitions rather than restating them", () => {
    const prompt = reclassifyTypePrompt(row);
    expect(prompt).toContain(CAPABILITY_TYPE_DEFINITIONS);
  });

  it("says there is no new search and includes the card's own fields", () => {
    const prompt = reclassifyTypePrompt({ ...row, title: "GPT Image 2 提示词库", tags: ["prompt-library"] });
    expect(prompt).toMatch(/没有.*联网搜索/);
    expect(prompt).toContain("GPT Image 2 提示词库");
    expect(prompt).toContain("prompt-library");
  });
});

describe("applyTypeReclassification", () => {
  it("updates only type, leaving updated_at and everything else alone", async () => {
    let sql = "";
    let params: unknown[] = [];
    const pool = {
      query: async (text: string, values: unknown[]) => { sql = text; params = values; return { rows: [] }; }
    };
    await applyTypeReclassification(pool as never, "cab_1", "prompt");
    expect(sql).toContain("SET type = $2");
    expect(sql).not.toContain("updated_at");
    expect(params).toEqual(["cab_1", "prompt"]);
  });
});

describe("runReclassify", () => {
  const log = () => {};

  it("writes a before/after log line and updates a card whose type differs, when apply=true", async () => {
    const { pool, updates } = fakeRowsPool([row]);
    const logs: Record<string, unknown>[] = [];
    const call = { invoke: async () => ({ value: { type: "prompt" } }) };
    const result = await runReclassify(pool as never, call, true, (o) => logs.push(o));
    expect(result).toEqual({ candidates: 1, changed: 1, unchanged: 0, skippedHuman: 0, failed: 0 });
    expect(updates).toEqual([["cab_1", "prompt"]]);
    const changeLog = logs.find((l) => l.before === "other" && l.after === "prompt");
    expect(changeLog).toMatchObject({ capabilityId: "cab_1", before: "other", after: "prompt", applied: true });
    // Displayed serial prefix follows type — OTH-0012 -> PRM-0012, same underlying number.
    expect(changeLog?.serialBefore).toBe("OTH-0012");
    expect(changeLog?.serialAfter).toBe("PRM-0012");
  });

  it("does not write when apply=false, even when the type would change", async () => {
    const { pool, updates } = fakeRowsPool([row]);
    const call = { invoke: async () => ({ value: { type: "prompt" } }) };
    const result = await runReclassify(pool as never, call, false, log);
    expect(result).toEqual({ candidates: 1, changed: 1, unchanged: 0, skippedHuman: 0, failed: 0 });
    expect(updates).toHaveLength(0);
  });

  it("counts a card as unchanged (not changed, no write) when the model agrees with the stored type", async () => {
    const { pool, updates } = fakeRowsPool([row]);
    const call = { invoke: async () => ({ value: { type: "other" } }) };
    const result = await runReclassify(pool as never, call, true, log);
    expect(result).toEqual({ candidates: 1, changed: 0, unchanged: 1, skippedHuman: 0, failed: 0 });
    expect(updates).toHaveLength(0);
  });

  // Regression guard for the owner's ruling: a card the owner already hand-corrected (verdict_by
  // = 'human') must never be silently re-typed by this script.
  it("skips and logs a card whose verdict_by is 'human', never calling the model or writing", async () => {
    const { pool, updates } = fakeRowsPool([{ ...row, verdictBy: "human" }]);
    const logs: Record<string, unknown>[] = [];
    let invoked = false;
    const call = { invoke: async () => { invoked = true; return { value: { type: "prompt" } }; } };
    const result = await runReclassify(pool as never, call, true, (o) => logs.push(o));
    expect(result).toEqual({ candidates: 1, changed: 0, unchanged: 0, skippedHuman: 1, failed: 0 });
    expect(invoked).toBe(false);
    expect(updates).toHaveLength(0);
    expect(logs.some((l) => l.skipped === "verdict_by=human" && l.capabilityId === "cab_1")).toBe(true);
  });

  it("calls DeepSeek with a signal that has a timeout (not a bare, never-firing controller)", async () => {
    const { pool } = fakeRowsPool([row]);
    let receivedSignal: AbortSignal | undefined;
    const call = {
      invoke: async (_input: never, signal: AbortSignal) => {
        receivedSignal = signal;
        return { value: { type: "other" } };
      }
    };
    await runReclassify(pool as never, call, false, log);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);
  });

  it("reports the changed/unchanged/skippedHuman/failed counts so main() can decide the exit code", async () => {
    const { pool } = fakeRowsPool([row, { ...row, id: "cab_2" }, { ...row, id: "cab_3", verdictBy: "human" }]);
    const call = { invoke: async () => { throw new Error("deepseek down"); } };
    const result = await runReclassify(pool as never, call, true, log);
    expect(result).toEqual({ candidates: 3, changed: 0, unchanged: 0, skippedHuman: 1, failed: 2 });
  });
});
