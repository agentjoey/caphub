import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runStructured, type StructuredCall } from "./structured";
import { RunBudget } from "./budget";
import { ProviderError } from "../providers/errors";

function recorder(): { rows: Array<Record<string, unknown>>; pool: Pick<Pool, "query"> } {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    pool: { query: async (_t: string, v: unknown[]) => { rows.push({ step: v[1], attempt: v[4], ok: v[8] }); return { rows: [] }; } } as unknown as Pick<Pool, "query">
  };
}
const schema = z.object({ n: z.number() });
const base = (call: StructuredCall, pool: Pick<Pool, "query">) => ({
  pool, runId: "run_1", step: "reason" as const, call, prompt: "p", schemaName: "t", schema,
  budget: new RunBudget(), timeoutMs: 1000, signal: new AbortController().signal
});

describe("runStructured", () => {
  it("returns parsed value and records one ok step", async () => {
    const { rows, pool } = recorder();
    const call = { provider: "x", model: "m", invoke: async () => ({ value: { n: 1 }, usage: { inputTokens: 1, outputTokens: 1 } }) };
    expect(await runStructured(base(call, pool))).toEqual({ n: 1 });
    expect(rows).toEqual([{ step: "reason", attempt: 1, ok: true }]);
  });
  it("retries once with correction on schema failure, then throws", async () => {
    const { rows, pool } = recorder();
    const seen: unknown[] = [];
    const call = { provider: "x", model: "m", invoke: async (i: { correction?: unknown }) => { seen.push(i.correction); return { value: { n: "bad" }, usage: { inputTokens: 1, outputTokens: 1 } }; } };
    await expect(runStructured(base(call, pool))).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toMatchObject({ issues: [expect.stringContaining("n")] });
    expect(rows.map((r) => r.ok)).toEqual([false, false]);
  });
  it("times out", async () => {
    const { pool } = recorder();
    const call: StructuredCall = {
      provider: "x",
      model: "m",
      invoke: (_i, s) => new Promise((_r, rej) => s.addEventListener("abort", () => rej(new ProviderError("ABORTED"))))
    };
    await expect(runStructured({ ...base(call, pool), timeoutMs: 10 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("enforces call budget", async () => {
    const { pool } = recorder();
    const budget = new RunBudget({ maxCalls: 0, maxTokens: 10 });
    const call = { provider: "x", model: "m", invoke: async () => ({ value: { n: 1 }, usage: { inputTokens: 1, outputTokens: 1 } }) };
    await expect(runStructured({ ...base(call, pool), budget })).rejects.toMatchObject({ code: "BUDGET" });
  });
});
