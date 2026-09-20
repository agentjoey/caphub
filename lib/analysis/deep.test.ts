import { describe, expect, it } from "vitest";
import type { StructuredInput } from "./structured";
import { DEEP_BUDGET_LIMITS, runDeepAnalysis, type DeepAnalysisDeps } from "./deep";

const lease = { runId: "run_1", captureId: "cap_1", pipeline: "mixed" as const, ownerToken: "t" };

const capabilityRow = {
  id: "cab_1", title: "Some Tool", type: "tool", summary: "A tool.", tags: ["cli"],
  source_url: null, playbook: { kind: "reference", points: ["p"] }, updated_at: "2026-09-01T00:00:00.000Z"
};

const planValue = { queries: ["official docs", "github repo", "reddit reviews", "vs alternatives"] };
const searchValue = { sources: [{ title: "Docs", url: "https://a.example/1", content: "c1" }] };
const factsValue = { facts: [{ text: "fact one", source: 0 }] };
const analysisValue = {
  headline: "h",
  architecture: { summary: "s1", points: ["p1", "p2", "p3"] },
  implementation: { summary: "s2", points: ["p1", "p2", "p3"] },
  use_cases: [{ title: "u1", detail: "d1" }, { title: "u2", detail: "d2" }, { title: "u3", detail: "d3" }],
  cases: [{ title: "c1", detail: "d1", source: 0 }],
  feedback: { positive: ["pos1"], negative: [] },
  risks: ["r1", "r2"],
  sources: [{ title: "Docs", url: "https://a.example/1" }]
};

function deps(opts: {
  capability?: typeof capabilityRow | null;
  planValueOverride?: unknown;
  factsValueOverride?: unknown;
  analysisValues?: unknown[]; // consumed in order across successive "deep_analysis" invokes (for retry tests)
  searchImpl?: (query: string) => Promise<{ value: unknown; usage: { inputTokens: number; outputTokens: number } }>;
  reasonUsage?: { inputTokens: number; outputTokens: number };
  /** Makes the `plan` call hang until its signal is aborted, then reject -- for exercising the overall run timeout deterministically. */
  hangPlanUntilAborted?: boolean;
} = {}) {
  const calls: string[] = [];
  const steps: Array<{ step: string; ok: boolean; error: string | null }> = [];
  const updates: Array<{ values: unknown[] }> = [];
  const capability = opts.capability === undefined ? capabilityRow : opts.capability;
  const usage = opts.reasonUsage ?? { inputTokens: 10, outputTokens: 10 };
  let analysisCallIndex = 0;
  const remainingAnalysisValues = opts.analysisValues ? [...opts.analysisValues] : [analysisValue];

  const pool = {
    query: async (text: string, values: unknown[] = []) => {
      if (text.startsWith("SELECT id, title, type, summary, tags, source_url, playbook, updated_at FROM caphub_v2.capabilities")) {
        return { rows: capability ? [capability] : [] };
      }
      if (text.includes("INSERT INTO caphub_v2.analysis_steps")) {
        steps.push({ step: values[1] as string, ok: values[8] as boolean, error: (values[9] as string | null) ?? null });
        return { rows: [] };
      }
      if (text.startsWith("UPDATE caphub_v2.capabilities SET deep_analysis")) {
        updates.push({ values });
        return { rows: [] };
      }
      return { rows: [] };
    }
  };

  const d: DeepAnalysisDeps = {
    pool: pool as never,
    reason: {
      provider: "deepseek", model: "d",
      invoke: async (input: StructuredInput, signal: AbortSignal) => {
        if (input.schemaName === "deep_plan") {
          calls.push("plan");
          if (opts.hangPlanUntilAborted) {
            return new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
            }) as never;
          }
          return { value: opts.planValueOverride ?? planValue, usage };
        }
        if (input.schemaName === "deep_facts") { calls.push("facts"); return { value: opts.factsValueOverride ?? factsValue, usage }; }
        calls.push("synthesize-final");
        const value = remainingAnalysisValues[Math.min(analysisCallIndex, remainingAnalysisValues.length - 1)];
        analysisCallIndex += 1;
        return { value, usage };
      }
    },
    search: {
      provider: "tavily", model: "s",
      search: async (query: string) => {
        calls.push(`search:${query}`);
        if (opts.searchImpl) return opts.searchImpl(query) as never;
        return { value: searchValue, usage: { inputTokens: 0, outputTokens: 0 } };
      }
    }
  };
  return { d, calls, steps, updates };
}

describe("runDeepAnalysis", () => {
  it("runs plan → search (one call per query) → synthesize (facts, then the final card) and validates against DeepAnalysis", async () => {
    const { d, calls, steps } = deps();
    const out = await runDeepAnalysis(d, lease, new AbortController().signal);
    expect(out).toEqual({ capabilityId: "cab_1" });
    expect(calls).toEqual([
      "plan",
      `search:${planValue.queries[0]}`, `search:${planValue.queries[1]}`, `search:${planValue.queries[2]}`, `search:${planValue.queries[3]}`,
      "facts", "synthesize-final"
    ]);
    expect(steps.map((s) => s.step)).toEqual(["plan", "search", "search", "search", "search", "synthesize", "synthesize"]);
    expect(steps.every((s) => s.ok)).toBe(true);
  });

  it("writes deep_analysis / deep_analysis_at / deep_analysis_of without touching updated_at, keyed off the card's updated_at read at the start of the run", async () => {
    const { d, updates } = deps();
    await runDeepAnalysis(d, lease, new AbortController().signal);
    expect(updates).toHaveLength(1);
    const [capabilityId, deepAnalysisJson, deepAnalysisOf] = updates[0].values;
    expect(capabilityId).toBe("cab_1");
    expect(JSON.parse(deepAnalysisJson as string)).toEqual(analysisValue);
    expect(deepAnalysisOf).toBe(capabilityRow.updated_at);
    expect(updates[0].values).toHaveLength(3);
  });

  it("throws CAPABILITY_NOT_FOUND when the capture has no capability row yet", async () => {
    const { d } = deps({ capability: null });
    await expect(runDeepAnalysis(d, lease, new AbortController().signal)).rejects.toMatchObject({ code: "CAPABILITY_NOT_FOUND" });
  });

  it("fails with BUDGET once the deep run's 8-call / 400k-token budget is exceeded, without writing deep_analysis", async () => {
    expect(DEEP_BUDGET_LIMITS).toEqual({ maxCalls: 8, maxTokens: 400_000 });
    const { d, updates } = deps({ reasonUsage: { inputTokens: 300_000, outputTokens: 0 } });
    await expect(runDeepAnalysis(d, lease, new AbortController().signal)).rejects.toMatchObject({ code: "BUDGET" });
    expect(updates).toHaveLength(0);
  });

  it("fails with TIMEOUT when the whole run exceeds its overall time budget, regardless of which step was in flight", async () => {
    const { d } = deps({ hangPlanUntilAborted: true });
    await expect(runDeepAnalysis(d, lease, new AbortController().signal, { runTimeoutMs: 5 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("retries the final synthesize pass (and then succeeds) when a case cites a source index outside the sources array", async () => {
    const badAnalysis = { ...analysisValue, cases: [{ title: "c1", detail: "d1", source: 5 }] };
    const { d, calls } = deps({ analysisValues: [badAnalysis, analysisValue] });
    const out = await runDeepAnalysis(d, lease, new AbortController().signal);
    expect(out).toEqual({ capabilityId: "cab_1" });
    expect(calls.filter((c) => c === "synthesize-final")).toHaveLength(2);
  });

  it("fails the run (invalid output, retried twice) when every synthesize attempt keeps citing an out-of-range source", async () => {
    const badAnalysis = { ...analysisValue, cases: [{ title: "c1", detail: "d1", source: 5 }] };
    const { d, calls } = deps({ analysisValues: [badAnalysis, badAnalysis] });
    await expect(runDeepAnalysis(d, lease, new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
    expect(calls.filter((c) => c === "synthesize-final")).toHaveLength(2);
  });

  it("treats a single query's search failure as non-fatal: the other queries and synthesize still run", async () => {
    let first = true;
    const { d, calls, steps } = deps({
      searchImpl: async () => {
        if (first) { first = false; throw new Error("network down"); }
        return { value: searchValue, usage: { inputTokens: 0, outputTokens: 0 } };
      }
    });
    const out = await runDeepAnalysis(d, lease, new AbortController().signal);
    expect(out).toEqual({ capabilityId: "cab_1" });
    expect(calls).toContain("synthesize-final");
    const failedSearch = steps.find((s) => s.step === "search" && !s.ok);
    expect(failedSearch).toBeDefined();
  });
});
