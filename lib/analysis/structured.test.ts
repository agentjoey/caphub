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
  it("records the attempt row when a response exceeds the token budget", async () => {
    const { rows, pool } = recorder();
    const budget = new RunBudget({ maxCalls: 4, maxTokens: 1 });
    const call = { provider: "x", model: "m", invoke: async () => ({ value: { n: 1 }, usage: { inputTokens: 1, outputTokens: 1 } }) };
    await expect(runStructured({ ...base(call, pool), budget })).rejects.toMatchObject({ code: "BUDGET" });
    expect(rows).toEqual([{ step: "reason", attempt: 1, ok: false }]);
  });

  function fullRecorder(): { rows: Array<Record<string, unknown>>; pool: Pick<Pool, "query"> } {
    const rows: Array<Record<string, unknown>> = [];
    return {
      rows,
      pool: {
        query: async (_t: string, v: unknown[]) => {
          rows.push({ step: v[1], attempt: v[4], inputTokens: v[5], outputTokens: v[6], ok: v[8], error: v[9], output: v[10] ? JSON.parse(v[10] as string) : null });
          return { rows: [] };
        }
      } as unknown as Pick<Pool, "query">
    };
  }

  it("retries once on unparseable output and succeeds on the second attempt", async () => {
    const { rows, pool } = fullRecorder();
    let calls = 0;
    const seenCorrection: unknown[] = [];
    const call: StructuredCall = {
      provider: "x", model: "m",
      invoke: async (i: { correction?: unknown }) => {
        calls += 1;
        seenCorrection.push(i.correction);
        if (calls === 1) throw new ProviderError("INVALID_OUTPUT", { raw: "not json", usage: { inputTokens: 5, outputTokens: 6 } });
        return { value: { n: 1 }, usage: { inputTokens: 1, outputTokens: 1 } };
      }
    };
    expect(await runStructured(base(call, pool))).toEqual({ n: 1 });
    expect(calls).toBe(2);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ attempt: 1, ok: false, error: "INVALID_JSON", inputTokens: 5, outputTokens: 6, output: { raw: "not json" } });
    expect(rows[1]).toMatchObject({ attempt: 2, ok: true });
    expect(seenCorrection[1]).toEqual({ issues: ["response was not a single valid JSON object"] });
  });

  it("throws INVALID_OUTPUT when the output is unparseable twice, recording two rows", async () => {
    const { rows, pool } = fullRecorder();
    const call: StructuredCall = {
      provider: "x", model: "m",
      invoke: async () => { throw new ProviderError("INVALID_OUTPUT", { raw: "still not json", usage: { inputTokens: 2, outputTokens: 3 } }); }
    };
    await expect(runStructured(base(call, pool))).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.error === "INVALID_JSON")).toBe(true);
  });

  it("records HTTP status/body detail in the step error text for other provider errors", async () => {
    const { rows, pool } = fullRecorder();
    const call: StructuredCall = {
      provider: "x", model: "m",
      invoke: async () => { throw new ProviderError("INVALID_OUTPUT", { detail: "HTTP 400: bad request: missing field" }); }
    };
    await expect(runStructured(base(call, pool))).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
    expect(rows[0].error).toContain("400");
  });

  it("passes video input through to call.invoke", async () => {
    const { pool } = recorder();
    const videoInput = { url: "https://www.youtube.com/watch?v=tYvu6IpSfiM", endOffsetSec: 300 };
    const seenInput: unknown[] = [];
    const call: StructuredCall = {
      provider: "x", model: "m",
      invoke: async (i: unknown) => { seenInput.push(i); return { value: { n: 1 }, usage: { inputTokens: 1, outputTokens: 1 } }; }
    };
    await runStructured({ ...base(call, pool), video: videoInput });
    expect(seenInput[0]).toMatchObject({ video: videoInput });
  });
});
