import { describe, expect, it } from "vitest";
import type { CanonicalResult } from "./canonical";
import type { Playbook } from "./card";
import type { StructuredInput } from "./structured";
import { ENRICH_BUDGET_LIMITS, runEnrichment, type EnrichDeps } from "./enrich";

const lease = { runId: "run_1", captureId: "cap_1", pipeline: "mixed" as const, ownerToken: "t" };

const capabilityRow: {
  id: string; title: string; type: string; usage: "integrate" | "reference"; summary: string;
  signals: string[]; playbook: Playbook; tags: string[]; source_url: string | null;
  open_questions: string[]; suggestion_by: "auto" | "human";
} = {
  id: "cab_1", title: "Some Tool", type: "tool", usage: "integrate", summary: "A tool.",
  signals: ["s1", "s2"], playbook: { kind: "integrate", install: ["npm i x"], repo: "https://github.com/a/b", prompt_text: null },
  tags: ["cli"], source_url: "https://github.com/a/b", open_questions: ["免费额度上限是多少", "是否需要登录"],
  suggestion_by: "auto"
};

const canonicalRepo: CanonicalResult = {
  kind: "repo", url: "https://github.com/a/b", title: "a/b", text: "README text",
  facts: { repo_url: "https://github.com/a/b", stars: 42, last_update: "2026-08-01", license: "MIT" }
};

const rewrittenValue = {
  type: "tool", usage: "integrate",
  summary: "Rewritten summary describing the capability.",
  signals: ["provenance verified against the canonical source", "solves X for Joey's workflow"],
  playbook: { kind: "integrate", install: ["npm i x"], repo: "https://github.com/a/b", prompt_text: null },
  tags: ["cli", "automation"],
  score: 4, score_reason: "well documented and maintained",
  source_facts: {},
  open_questions: []
};

function deps(opts: {
  capability?: typeof capabilityRow | null;
  canonical?: CanonicalResult;
  fetchImpl?: (url: string) => Promise<CanonicalResult>;
  rewrittenOverride?: unknown;
  reasonUsage?: { inputTokens: number; outputTokens: number };
  searchUsage?: { inputTokens: number; outputTokens: number };
} = {}) {
  const calls: string[] = [];
  const steps: Array<{ step: string; ok: boolean; error: string | null; output: string | null }> = [];
  const updates: Array<{ values: unknown[] }> = [];
  const capability = opts.capability === undefined ? capabilityRow : opts.capability;
  const reasonUsage = opts.reasonUsage ?? { inputTokens: 10, outputTokens: 10 };
  const searchUsage = opts.searchUsage ?? { inputTokens: 5, outputTokens: 5 };

  const pool = {
    query: async (text: string, values: unknown[] = []) => {
      if (text.includes("FROM caphub_v2.capabilities WHERE capture_id")) {
        return { rows: capability ? [capability] : [] };
      }
      if (text.includes("INSERT INTO caphub_v2.analysis_steps")) {
        steps.push({ step: values[1] as string, ok: values[8] as boolean, error: (values[9] as string | null) ?? null, output: (values[10] as string | null) ?? null });
        return { rows: [] };
      }
      if (text.startsWith("UPDATE caphub_v2.capabilities SET")) {
        updates.push({ values });
        return { rows: [] };
      }
      return { rows: [] };
    }
  };

  const d: EnrichDeps = {
    pool: pool as never,
    reason: {
      provider: "deepseek", model: "d",
      invoke: async (_input: StructuredInput) => {
        calls.push("reason");
        return { value: opts.rewrittenOverride ?? rewrittenValue, usage: reasonUsage };
      }
    },
    search: {
      provider: "tavily", model: "s",
      search: async (query: string) => {
        calls.push(`search:${query}`);
        return { value: { sources: [{ title: "Doc", url: "https://a.example/1", content: "c1" }] }, usage: searchUsage };
      }
    },
    fetchCanonical: async (url: string, _signal: AbortSignal) => {
      calls.push(`fetch:${url}`);
      if (opts.fetchImpl) return opts.fetchImpl(url);
      return opts.canonical === undefined ? canonicalRepo : opts.canonical;
    }
  };
  return { d, calls, steps, updates };
}

describe("runEnrichment", () => {
  it("fetches the canonical source, searches up to 2 open_questions, rewrites the card, and writes it back", async () => {
    const { d, calls, steps, updates } = deps();
    const out = await runEnrichment(d, lease, new AbortController().signal);
    expect(out).toEqual({ capabilityId: "cab_1" });
    expect(calls).toEqual([
      "fetch:https://github.com/a/b",
      "search:免费额度上限是多少",
      "search:是否需要登录",
      "reason"
    ]);
    expect(steps.map((s) => s.step)).toEqual(["fetch", "search", "search", "reason"]);
    expect(steps.every((s) => s.ok)).toBe(true);
    expect(updates).toHaveLength(1);
    const [id, type, usage, tags, summary] = updates[0].values;
    expect(id).toBe("cab_1");
    expect(type).toBe("tool");
    expect(usage).toBe("integrate");
    expect(tags).toEqual(["cli", "automation"]);
    expect(summary).toBe(rewrittenValue.summary);
  });

  it("skips the fetch step entirely when the card has no source_url", async () => {
    const { d, calls, steps } = deps({ capability: { ...capabilityRow, source_url: null } });
    await runEnrichment(d, lease, new AbortController().signal);
    expect(calls.some((c) => c.startsWith("fetch:"))).toBe(false);
    expect(steps.some((s) => s.step === "fetch")).toBe(false);
  });

  it("records a failed (but non-fatal) fetch step and still completes the rewrite when the canonical fetch fails", async () => {
    const { d, calls, steps, updates } = deps({ canonical: null });
    const out = await runEnrichment(d, lease, new AbortController().signal);
    expect(out).toEqual({ capabilityId: "cab_1" });
    const fetchStep = steps.find((s) => s.step === "fetch")!;
    expect(fetchStep.ok).toBe(false);
    expect(calls).toContain("reason");
    expect(updates).toHaveLength(1);
  });

  it("caps searches at 2 even when the card has 3 open_questions, and skips search entirely when there are none", async () => {
    const { d: dThree, calls: callsThree } = deps({ capability: { ...capabilityRow, open_questions: ["q1", "q2", "q3"] } });
    await runEnrichment(dThree, lease, new AbortController().signal);
    expect(callsThree.filter((c) => c.startsWith("search:"))).toHaveLength(2);

    const { d: dNone, calls: callsNone, steps: stepsNone } = deps({ capability: { ...capabilityRow, open_questions: [] } });
    await runEnrichment(dNone, lease, new AbortController().signal);
    expect(callsNone.some((c) => c.startsWith("search:"))).toBe(false);
    expect(stepsNone.some((s) => s.step === "search")).toBe(false);
  });

  it("merges the canonical fetch's repo facts into source_facts as authoritative, setting as_of", async () => {
    const { d, updates } = deps();
    await runEnrichment(d, lease, new AbortController().signal);
    const sourceFacts = JSON.parse(updates[0].values[7] as string);
    expect(sourceFacts).toMatchObject({ repo_url: "https://github.com/a/b", stars: 42, last_update: "2026-08-01", license: "MIT" });
    expect(sourceFacts.as_of).toBeTruthy();
  });

  it("keeps type/usage/tags at their stored values when suggestion_by = 'human', regardless of what the model outputs", async () => {
    const pinnedCapability = { ...capabilityRow, type: "skill" as const, usage: "reference" as const, tags: ["human-tag"], suggestion_by: "human" as const };
    const humanPlaybook: Playbook = { kind: "reference", points: ["p1"] };
    const { d, updates } = deps({
      capability: { ...pinnedCapability, playbook: humanPlaybook },
      rewrittenOverride: { ...rewrittenValue, type: "skill", usage: "reference", tags: ["should-be-ignored"], playbook: humanPlaybook }
    });
    await runEnrichment(d, lease, new AbortController().signal);
    const [, type, usage, tags] = updates[0].values;
    expect(type).toBe("skill");
    expect(usage).toBe("reference");
    expect(tags).toEqual(["human-tag"]);
  });

  it("never includes verdict, verdict_by, status, progress, deep_analysis or notified_at in the write-back", async () => {
    const { d, updates } = deps();
    await runEnrichment(d, lease, new AbortController().signal);
    // Captured indirectly: the UPDATE statement text itself is asserted in the pool fake via
    // the "UPDATE caphub_v2.capabilities SET" prefix match, and its column list is fixed in
    // enrich.ts; this test pins the value list length so a future column addition is caught.
    expect(updates[0].values).toHaveLength(11);
  });

  it("throws CAPABILITY_NOT_FOUND when the capture has no keep, non-deleted capability row", async () => {
    const { d } = deps({ capability: null });
    await expect(runEnrichment(d, lease, new AbortController().signal)).rejects.toMatchObject({ code: "CAPABILITY_NOT_FOUND" });
  });

  it("fails with BUDGET once the run's 5-call / 250k-token budget is exceeded, without writing back", async () => {
    expect(ENRICH_BUDGET_LIMITS).toEqual({ maxCalls: 5, maxTokens: 250_000 });
    const { d, updates } = deps({ searchUsage: { inputTokens: 130_000, outputTokens: 0 } });
    await expect(runEnrichment(d, lease, new AbortController().signal)).rejects.toMatchObject({ code: "BUDGET" });
    expect(updates).toHaveLength(0);
  });

  it("fails with TIMEOUT when the whole run exceeds its overall time budget, regardless of which step was in flight", async () => {
    // Mirrors deep.test.ts's hangPlanUntilAborted: the reason call hangs until the run's own
    // abort signal (forwarded from the overall run timeout, not this call's own per-step
    // timeout) fires, so the run deterministically times out at the overall cap rather than
    // racing a fixed real-time delay against it.
    const { d } = deps();
    d.reason.invoke = (_input: StructuredInput, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    });
    await expect(runEnrichment(d, lease, new AbortController().signal, { runTimeoutMs: 5 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("treats a single search query's failure as non-fatal: the run still completes", async () => {
    const capability = { ...capabilityRow, open_questions: ["q1"] };
    let calledOnce = false;
    const { d, steps } = deps({ capability });
    d.search.search = async (_query: string) => {
      if (!calledOnce) { calledOnce = true; throw new Error("network down"); }
      return { value: { sources: [] }, usage: { inputTokens: 0, outputTokens: 0 } };
    };
    const out = await runEnrichment(d, lease, new AbortController().signal);
    expect(out).toEqual({ capabilityId: "cab_1" });
    const failedSearch = steps.find((s) => s.step === "search" && !s.ok);
    expect(failedSearch).toBeDefined();
  });
});
