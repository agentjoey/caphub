import type { Pool } from "pg";
import type { Config } from "../config";
import { createDeepSeekCall } from "../providers/deepseek";
import { ProviderError } from "../providers/errors";
import type { SearchCall } from "../providers/minimax-search";
import { createTavilySearch } from "../providers/tavily";
import type { Lease } from "../queue/runs";
import { jsonStringifyStripNul } from "../text/sanitize";
import { RunBudget } from "./budget";
import {
  deepAnalysisSchema, deepFactsSchema, deepPlanSchema,
  type CapabilityType, type DeepAnalysis, type DeepSource, type Playbook, type SearchResult
} from "./card";
import { deepFactsPrompt, deepPlanPrompt, deepSynthesizePrompt, type DeepSubject } from "./prompts";
import { recordStep } from "./steps";
import { runStructured, withTimeout, type StructuredCall } from "./structured";

export const DEEP_TIMEOUTS = { plan: 60_000, search: 60_000, synthesize: 120_000 } as const;
/** Whole-run cap (design decision): a deep run must not run forever even if every step is slow. */
export const DEEP_RUN_TIMEOUT_MS = 300_000;
/**
 * A separate, larger budget than the normal analysis run's default (4 calls / 200k tokens,
 * see budget.ts) -- deep analysis does far more provider work. A full run is 1 plan + up to 5
 * search + 2 synthesize = 8 calls (controller ruling, fix round 1: the plan step is capped at
 * 5 queries, not 6, precisely so this worst case never exceeds 8); the cap here is raised to
 * 10 so a single retry of a synthesize step (invalid output / out-of-range source index) still
 * fits inside the budget instead of killing the run. Never shared with or derived from the
 * normal run's RunBudget instance; each run constructs its own.
 *
 * 一次完整深度分析约 8 次调用（上限 10）。
 */
export const DEEP_BUDGET_LIMITS = { maxCalls: 10, maxTokens: 400_000 };

export interface DeepAnalysisDeps {
  pool: Pick<Pool, "query">;
  /** DeepSeek structured call, reused for both the `plan` step and the two `synthesize` passes. */
  reason: StructuredCall;
  /** Tavily search, one call per planned query. */
  search: SearchCall;
}

/** Builds deep-analysis deps from config, or undefined when a required key is missing (mirrors createPipelineDeps' per-pipeline key checks). */
export function createDeepAnalysisDeps(config: Config, pool: Pool): DeepAnalysisDeps | undefined {
  const { deepseekApiKey, tavilyApiKey } = config.providers;
  if (!deepseekApiKey || !tavilyApiKey) return undefined;
  return { pool, reason: createDeepSeekCall({ apiKey: deepseekApiKey }), search: createTavilySearch({ apiKey: tavilyApiKey }) };
}

interface CapabilityRow {
  id: string; title: string; type: CapabilityType; summary: string; tags: string[];
  source_url: string | null; playbook: Playbook; updated_at: string;
}

/**
 * Re-checks `verdict = 'keep' AND deleted_at IS NULL` at claim time, not just eligibility time:
 * requestDeepAnalysis() only checks this when the run is *queued*, and the card can be discarded
 * or soft-deleted in the time between queueing and a worker claiming the lease. Without this
 * re-check here, a run claimed for a since-discarded card would still spend ~8 provider calls
 * (see DEEP_BUDGET_LIMITS) and write a deep analysis onto a card nobody wants it on -- failing
 * cheaply via the same CAPABILITY_NOT_FOUND path as a missing row is far cheaper.
 */
async function loadCapability(pool: Pick<Pool, "query">, captureId: string): Promise<CapabilityRow | null> {
  const row = (await pool.query<CapabilityRow>(
    "SELECT id, title, type, summary, tags, source_url, playbook, updated_at FROM caphub_v2.capabilities WHERE capture_id = $1 AND verdict = 'keep' AND deleted_at IS NULL",
    [captureId]
  )).rows[0];
  return row ?? null;
}

/**
 * One Tavily call for one planned query, recorded as a `search` step. Mirrors pipeline.ts's
 * runSearch: a single query's search failure is non-fatal (facts/synthesize can still work off
 * whatever other queries returned), but BUDGET/ABORTED must still end the whole run.
 */
async function runDeepSearch(deps: DeepAnalysisDeps, runId: string, query: string, budget: RunBudget, signal: AbortSignal): Promise<SearchResult> {
  budget.assertCanCall();
  budget.calls += 1;
  const started = Date.now();
  const base = { runId, step: "search" as const, provider: deps.search.provider, model: deps.search.model, attempt: 1 };
  const t = withTimeout(signal, DEEP_TIMEOUTS.search);
  let out: Awaited<ReturnType<SearchCall["search"]>>;
  try {
    out = await deps.search.search(query, t.signal);
  } catch (error) {
    const code = t.timedOut() ? "TIMEOUT" : error instanceof ProviderError ? error.code : "UNAVAILABLE";
    await recordStep(deps.pool, { ...base, durationMs: Date.now() - started, ok: false, error: code });
    if (code === "BUDGET" || code === "ABORTED") throw error instanceof ProviderError ? error : new ProviderError(code);
    return { sources: [] };
  } finally {
    t.clear();
  }
  try {
    budget.charge(out.usage.inputTokens + out.usage.outputTokens);
  } catch (error) {
    await recordStep(deps.pool, { ...base, inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens, durationMs: Date.now() - started, ok: false, error: "BUDGET", output: out.value });
    throw error;
  }
  await recordStep(deps.pool, { ...base, inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens, durationMs: Date.now() - started, ok: true, output: out.value });
  return out.value;
}

/**
 * Runs the deep-analysis pipeline for a leased run: plan (1 DeepSeek call, 4-5 queries) →
 * search (one Tavily call per query, ≤ 5) → synthesize (two DeepSeek passes: facts, then the
 * final scannable card). On success, writes `capabilities.deep_analysis` / `deep_analysis_at` /
 * `deep_analysis_of` without touching `updated_at` (that would re-trigger re-embedding for
 * nothing). On failure, nothing is written here -- the caller (worker/tick.ts's runTick) records
 * the run's own failed state/error via RunQueue.finish, same as the normal pipeline.
 */
export async function runDeepAnalysis(deps: DeepAnalysisDeps, lease: Lease, signal: AbortSignal, opts: { runTimeoutMs?: number } = {}): Promise<{ capabilityId: string }> {
  const t = withTimeout(signal, opts.runTimeoutMs ?? DEEP_RUN_TIMEOUT_MS);
  try {
    const capability = await loadCapability(deps.pool, lease.captureId);
    if (!capability) throw Object.assign(new Error("CAPABILITY_NOT_FOUND"), { code: "CAPABILITY_NOT_FOUND" });
    const subject: DeepSubject = {
      title: capability.title, type: capability.type, summary: capability.summary,
      tags: capability.tags, source_url: capability.source_url, playbook: capability.playbook
    };
    const budget = new RunBudget(DEEP_BUDGET_LIMITS);

    const plan = await runStructured({
      pool: deps.pool, runId: lease.runId, step: "plan", call: deps.reason,
      prompt: deepPlanPrompt(subject), schemaName: "deep_plan", schema: deepPlanSchema,
      budget, timeoutMs: DEEP_TIMEOUTS.plan, signal: t.signal
    });

    const sources: DeepSource[] = [];
    const seenUrls = new Set<string>();
    for (const query of plan.queries) {
      const result = await runDeepSearch(deps, lease.runId, query, budget, t.signal);
      for (const s of result.sources) {
        if (seenUrls.has(s.url)) continue;
        seenUrls.add(s.url);
        sources.push({ title: s.title, url: s.url });
      }
    }

    const factsResult = await runStructured({
      pool: deps.pool, runId: lease.runId, step: "synthesize", call: deps.reason,
      prompt: deepFactsPrompt(subject, sources), schemaName: "deep_facts", schema: deepFactsSchema,
      budget, timeoutMs: DEEP_TIMEOUTS.synthesize, signal: t.signal
    });

    const analysis: DeepAnalysis = await runStructured({
      pool: deps.pool, runId: lease.runId, step: "synthesize", call: deps.reason,
      prompt: deepSynthesizePrompt(subject, sources, factsResult.facts.map((f) => f.text)),
      schemaName: "deep_analysis", schema: deepAnalysisSchema,
      budget, timeoutMs: DEEP_TIMEOUTS.synthesize, signal: t.signal
    });

    await deps.pool.query(
      "UPDATE caphub_v2.capabilities SET deep_analysis = $2, deep_analysis_at = now(), deep_analysis_of = $3 WHERE id = $1",
      [capability.id, jsonStringifyStripNul(analysis), capability.updated_at]
    );

    return { capabilityId: capability.id };
  } catch (error) {
    // A run that blew the overall 5-minute cap is reported as TIMEOUT regardless of which
    // step it was mid-flight in, or what that step's own error happened to be (aborting a
    // provider call surfaces as ABORTED/UNAVAILABLE from that provider, not TIMEOUT).
    if (t.timedOut()) throw new ProviderError("TIMEOUT", { cause: error });
    throw error;
  } finally {
    t.clear();
  }
}
