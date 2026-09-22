import type { Pool } from "pg";
import { z } from "zod";
import type { Config } from "../config";
import { createDeepSeekCall } from "../providers/deepseek";
import { ProviderError } from "../providers/errors";
import type { SearchCall } from "../providers/minimax-search";
import { createTavilySearch } from "../providers/tavily";
import type { Lease } from "../queue/runs";
import { jsonStringifyStripNul, stripNul } from "../text/sanitize";
import { RunBudget } from "./budget";
import { fetchCanonical, type CanonicalResult } from "./canonical";
import {
  cardObjectSchema, finalizeSourceFacts, type CapabilityType, type Playbook, type SearchResult, type SourceFacts, type SummaryPoint
} from "./card";
import { parseYouTubeUrl } from "./material/youtube";
import { enrichPrompt, type EnrichSubject } from "./prompts";
import { recordStep } from "./steps";
import { runStructured, withTimeout, type StructuredCall } from "./structured";
import { bumpTags } from "./tags";

export const ENRICH_TIMEOUTS = { search: 60_000, reason: 120_000 } as const;
/** Whole-run cap (design decision, M3.7 brief): 3 minutes, regardless of which step is in flight. */
export const ENRICH_RUN_TIMEOUT_MS = 180_000;
/**
 * Deliberately smaller than the deep-analysis budget (10 calls / 400k tokens, deep.ts): a full
 * enrichment run is at most 1 fetch (not budget-metered, not a paid reasoning call) + 2 search +
 * 1 reason = 3 calls, so 5/250k leaves comfortable room for one retry of the reason step (the
 * only step `runStructured` ever retries) without ever approaching the cap.
 */
export const ENRICH_BUDGET_LIMITS = { maxCalls: 5, maxTokens: 250_000 };
/** At most 2 of the first pass's ≤3 open_questions become search queries (brief, M3.7 task 3). */
export const ENRICH_MAX_SEARCHES = 2;

export interface EnrichDeps {
  pool: Pick<Pool, "query">;
  /** DeepSeek structured call for the single rewrite ("reason") step. */
  reason: StructuredCall;
  /** Tavily search, one call per targeted open_question (≤ 2). */
  search: SearchCall;
  /**
   * Wraps canonical.ts's fetchCanonical -- injected (rather than imported and called directly)
   * so tests can fake it without a real network/DNS round trip. Never throws (see canonical.ts);
   * a null result means "couldn't fetch" and is not itself a failure.
   */
  fetchCanonical(url: string, signal: AbortSignal): Promise<CanonicalResult>;
  /**
   * Best-effort: edits the card's already-sent Telegram message in place with its freshly
   * enriched render (M3.7 controller ruling -- the whole point of this pass is that the phone
   * card stops showing the pre-enrichment, process-narrating summary forever). Optional and
   * injected from the telegram module (see lib/telegram/decide.ts's `editCardAfterEnrich`) so
   * this layer never imports the bot client directly; a no-op when the capture was never pushed
   * to Telegram (no stored chat/message id). Must never throw -- `runEnrichment` also wraps its
   * call as belt-and-braces, but the contract is that this resolves even on failure, having
   * logged it itself. Never reads or writes `notified_at`: an edit is not a push.
   */
  notifyEnriched?(capabilityId: string, signal: AbortSignal): Promise<void>;
}

/** Builds enrichment deps from config, or undefined when a required key is missing (mirrors createDeepAnalysisDeps). */
export function createEnrichDeps(config: Config, pool: Pool): EnrichDeps | undefined {
  const { deepseekApiKey, tavilyApiKey } = config.providers;
  if (!deepseekApiKey || !tavilyApiKey) return undefined;
  return {
    pool,
    reason: createDeepSeekCall({ apiKey: deepseekApiKey }),
    search: createTavilySearch({ apiKey: tavilyApiKey }),
    fetchCanonical: (url, signal) => fetchCanonical(url, { fetch, signal })
  };
}

interface CapabilityRow {
  id: string; title: string; type: CapabilityType; usage: "integrate" | "reference"; summary: string;
  summary_points: SummaryPoint[];
  signals: string[]; playbook: Playbook; tags: string[]; source_url: string | null;
  open_questions: string[]; suggestion_by: "auto" | "human";
}

/**
 * Re-checks `verdict = 'keep' AND deleted_at IS NULL` at claim time, not just at enqueue time --
 * same rationale as runDeepAnalysis's loadCapability (deep.ts): the card can be discarded or
 * soft-deleted in the time between being queued for enrichment and a worker claiming the lease.
 */
async function loadCapability(pool: Pick<Pool, "query">, captureId: string): Promise<CapabilityRow | null> {
  const row = (await pool.query<CapabilityRow>(
    `SELECT id, title, type, usage, summary, summary_points, signals, playbook, tags, source_url, open_questions, suggestion_by
     FROM caphub_v2.capabilities WHERE capture_id = $1 AND verdict = 'keep' AND deleted_at IS NULL`,
    [captureId]
  )).rows[0];
  return row ?? null;
}

/**
 * Fetches the card's canonical source and records it as a `fetch` step. Only called when
 * `source_url` is set (the caller's job) -- there is nothing to fetch otherwise, and skipping
 * the call entirely (rather than calling it with an empty string) means no `fetch` step is
 * logged for a card with no source link at all.
 */
async function runFetch(deps: EnrichDeps, runId: string, url: string, signal: AbortSignal): Promise<CanonicalResult> {
  const started = Date.now();
  const base = { runId, step: "fetch" as const, provider: "canonical", model: "http", attempt: 1 };
  let result: CanonicalResult;
  try {
    result = await deps.fetchCanonical(url, signal);
  } catch {
    // fetchCanonical is documented to never throw (canonical.ts) -- belt-and-braces only, so a
    // misbehaving fake/implementation still can't crash the run.
    result = null;
  }
  await recordStep(deps.pool, { ...base, durationMs: Date.now() - started, ok: result !== null, output: result });
  return result;
}

/**
 * One Tavily call for one open_question, recorded as a `search` step. Mirrors pipeline.ts's
 * runSearch / deep.ts's runDeepSearch: a single query's failure is non-fatal (the rewrite can
 * still work off the canonical fetch and whatever other queries returned), but BUDGET/ABORTED
 * must still end the whole run.
 */
async function runEnrichSearch(deps: EnrichDeps, runId: string, query: string, budget: RunBudget, signal: AbortSignal): Promise<SearchResult> {
  budget.assertCanCall();
  budget.calls += 1;
  const started = Date.now();
  const base = { runId, step: "search" as const, provider: deps.search.provider, model: deps.search.model, attempt: 1 };
  const t = withTimeout(signal, ENRICH_TIMEOUTS.search);
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
 * Reuses `cardObjectSchema`'s own field schemas (tag rules, length caps, playbook shape, etc.)
 * so the rewrite validates identically to the first pass, but keeps only the fields this pass
 * actually rewrites -- no `scenarios`/`overlap`/`suggested_verdict`/`confidence`, which belong
 * to the first-pass triage and are never touched here. `pinned`, when given, narrows `type` and
 * `usage` to a `z.literal` of the stored (human-set) values -- see refineCard's note in card.ts
 * on why this must happen at the schema layer rather than a post-hoc field swap: it keeps a
 * disobedient model's mismatched playbook failing validation (and retrying) instead of silently
 * storing a playbook whose shape disagrees with the type/usage this card is about to be pinned
 * back to.
 */
function enrichCardSchemaFor(pinned?: { type: CapabilityType; usage: "integrate" | "reference" }) {
  const base = cardObjectSchema.pick({
    type: true, usage: true, summary: true, summary_points: true, signals: true, playbook: true, tags: true,
    score: true, score_reason: true, source_facts: true, open_questions: true
  });
  const withPin = pinned ? base.extend({ type: z.literal(pinned.type), usage: z.literal(pinned.usage) }) : base;
  // Same type/playbook/usage coherence checks as card.ts's refineCard, minus the overlap checks
  // (this pass never judges overlap) -- kept local since refineCard's generic signature requires
  // an `overlap` field this schema doesn't have.
  return withPin.superRefine((card, ctx) => {
    if (card.type === "experience" && card.playbook.kind !== "experience") {
      ctx.addIssue({ code: "custom", path: ["playbook"], message: "experience type requires experience playbook" });
    }
    if (card.type !== "experience" && card.playbook.kind === "experience") {
      ctx.addIssue({ code: "custom", path: ["playbook"], message: "experience playbook requires experience type" });
    }
    if (card.type !== "experience") {
      if (card.usage === "integrate" && card.playbook.kind !== "integrate") {
        ctx.addIssue({ code: "custom", path: ["playbook"], message: "integrate usage requires integrate playbook" });
      }
      if (card.usage === "reference" && card.playbook.kind !== "reference") {
        ctx.addIssue({ code: "custom", path: ["playbook"], message: "reference usage requires reference playbook" });
      }
    }
  });
}
export type EnrichCard = z.infer<ReturnType<typeof enrichCardSchemaFor>>;

/**
 * Merges the model's `source_facts` with the canonical fetch's own facts (GitHub API fields),
 * when there are any -- the canonical fetch is authoritative (brief, M3.7 task 3), so its
 * values win over whatever the model wrote for the same key, rather than trusting the model to
 * have copied them correctly.
 */
function mergeSourceFacts(modelFacts: SourceFacts, canonical: CanonicalResult): SourceFacts {
  if (!canonical || canonical.kind !== "repo") return modelFacts;
  const f = canonical.facts;
  const merged: SourceFacts = { ...modelFacts };
  if (f.repo_url !== undefined) merged.repo_url = f.repo_url;
  if (f.stars !== undefined) merged.stars = f.stars;
  if (f.last_update !== undefined) merged.last_update = f.last_update;
  if (f.license !== undefined) merged.license = f.license;
  if (f.homepage !== undefined) merged.homepage = f.homepage;
  return merged;
}

/**
 * Fallback search query for a card whose `open_questions` is empty (see `runEnrichment`) --
 * migration 011 defaults every backfilled card's `open_questions` to `'[]'`, so this is the
 * normal path at go-live, not a corner case: without it, every one of those 44 cards would run
 * zero searches. Mirrors the shape of the first pass's own query-building (prompts.ts's
 * `searchQuery`: "what it is" plus hints) with what this pass has on hand instead of an
 * `Extraction` -- the card's own title and type.
 */
function enrichFallbackQuery(capability: Pick<CapabilityRow, "title" | "type">): string {
  return `${capability.title} ${capability.type}`.trim();
}

/** Order-insensitive tag-set equality, so a rewrite that keeps the same tags (just reordered) doesn't spuriously bump their counts. */
function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((t, i) => t === sortedB[i]);
}

/**
 * Runs the enrichment pass ("补充调研") for a leased `enrich` run: fetch the card's canonical
 * source (when it has one) → up to 2 Tavily searches targeting its open_questions → one
 * DeepSeek rewrite. On success, rewrites `summary`/`signals`/`playbook`/`source_facts`/`score`/
 * `score_reason`/`open_questions` and sets `enriched_at`; `type`/`usage`/`tags` are kept as
 * stored when `suggestion_by = 'human'`, otherwise taken from the rewrite. Never touches
 * `verdict`/`verdict_by`/`status`/`progress`/`deep_analysis`/`notified_at` -- clearing
 * `notified_at` in particular would re-push the card to Telegram, which a background rewrite
 * must never do.
 */
export async function runEnrichment(deps: EnrichDeps, lease: Lease, signal: AbortSignal, opts: { runTimeoutMs?: number } = {}): Promise<{ capabilityId: string }> {
  const t = withTimeout(signal, opts.runTimeoutMs ?? ENRICH_RUN_TIMEOUT_MS);
  try {
    const capability = await loadCapability(deps.pool, lease.captureId);
    if (!capability) throw Object.assign(new Error("CAPABILITY_NOT_FOUND"), { code: "CAPABILITY_NOT_FOUND" });
    // A video card summarises the video itself (Joey, 2026-09-22); this pass rewrites a card from
    // web sources, which is exactly what a video card must not become. Finish as done without
    // stamping enriched_at. Deep analysis (explicitly requested topic research) is unaffected.
    const capture = (await deps.pool.query<{ url: string | null }>(
      "SELECT url FROM caphub_v2.captures WHERE id = $1", [lease.captureId])).rows[0];
    if (capture?.url && parseYouTubeUrl(capture.url)) return { capabilityId: capability.id };
    const budget = new RunBudget(ENRICH_BUDGET_LIMITS);

    const canonical = capability.source_url ? await runFetch(deps, lease.runId, capability.source_url, t.signal) : null;

    // A card with no open_questions (every backfilled card, per migration 011's default -- see
    // enrichFallbackQuery) still gets one search, built from its title/type, so this pass has
    // something to work from beyond the canonical fetch.
    const questions = capability.open_questions.length
      ? capability.open_questions.slice(0, ENRICH_MAX_SEARCHES)
      : [enrichFallbackQuery(capability)];
    const searchResults: Array<{ question: string; sources: SearchResult["sources"] }> = [];
    for (const question of questions) {
      const result = await runEnrichSearch(deps, lease.runId, question, budget, t.signal);
      searchResults.push({ question, sources: result.sources });
    }

    // Nothing new to work from -- the canonical fetch found nothing (or there was no source_url)
    // and every search came back empty. Running the rewrite anyway would just have DeepSeek
    // restate (or hallucinate over) the existing card while stamping enriched_at as though
    // 补充调研 had actually happened. Skip it: finish the run as done and leave enriched_at NULL
    // so a later rerun gets a genuine chance instead of this card being falsely marked enriched.
    const hasNewMaterial = canonical !== null || searchResults.some((r) => r.sources.length > 0);
    if (!hasNewMaterial) {
      return { capabilityId: capability.id };
    }

    const pinned = capability.suggestion_by === "human";
    const subject: EnrichSubject = {
      title: capability.title, type: capability.type, usage: capability.usage, summary: capability.summary,
      summary_points: capability.summary_points,
      signals: capability.signals, playbook: capability.playbook, tags: capability.tags,
      source_url: capability.source_url, open_questions: capability.open_questions, pinned
    };
    const rewritten = await runStructured({
      pool: deps.pool, runId: lease.runId, step: "reason", call: deps.reason,
      prompt: enrichPrompt(subject, canonical, searchResults),
      schemaName: "enrich_card",
      schema: enrichCardSchemaFor(pinned ? { type: capability.type, usage: capability.usage } : undefined),
      budget, timeoutMs: ENRICH_TIMEOUTS.reason, signal: t.signal
    });

    const sourceFacts = finalizeSourceFacts(mergeSourceFacts(rewritten.source_facts, canonical));

    // The `suggestion_by = 'human'` guard is re-evaluated by the CASE expressions below against
    // the row's *current* value at UPDATE time, not `capability.suggestion_by` read up to
    // ENRICH_RUN_TIMEOUT_MS (3 minutes) earlier at the top of this run -- a 改建议 landing
    // mid-run (setting suggestion_by='human' plus new type/usage/tags) must not be silently
    // reverted by this run writing back the auto values it read before that edit happened.
    // This mirrors upsertCapability's existing verdict_by/type_by CASE pattern (capabilities.ts).
    // The schema-level `z.literal` pinning above (enrichCardSchemaFor) is a belt-and-braces
    // layer only when suggestion_by was already 'human' at load time -- this CASE is the actual
    // enforcement against a suggestion_by that changed after that.
    const result = await deps.pool.query(
      `UPDATE caphub_v2.capabilities SET
         type = CASE WHEN suggestion_by = 'human' THEN type ELSE $2 END,
         usage = CASE WHEN suggestion_by = 'human' THEN usage ELSE $3 END,
         tags = CASE WHEN suggestion_by = 'human' THEN tags ELSE $4 END,
         summary = $5, summary_points = $12, signals = $6, playbook = $7,
         source_facts = $8, score = $9, score_reason = $10, open_questions = $11,
         enriched_at = now(), updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
      [
        capability.id, rewritten.type, rewritten.usage, rewritten.tags.map(stripNul), stripNul(rewritten.summary), jsonStringifyStripNul(rewritten.signals),
        jsonStringifyStripNul(rewritten.playbook), jsonStringifyStripNul(sourceFacts), rewritten.score,
        stripNul(rewritten.score_reason), jsonStringifyStripNul(rewritten.open_questions), jsonStringifyStripNul(rewritten.summary_points)
      ]
    );
    if (result.rowCount === 0) {
      // The card was soft-deleted between loadCapability's read and this write -- not a failure
      // worth retrying (there's nothing left to enrich), but worth surfacing since it means the
      // run's provider calls above were spent for nothing.
      console.warn(JSON.stringify({ runId: lease.runId, enrichWriteBack: "no matching row (deleted mid-run?)", capabilityId: capability.id }));
    } else {
      // Mirrors pipeline.ts's own write path: bumpTags only when the write actually landed and
      // the tags this run wrote actually changed (never for a pinned card, whose tags column the
      // UPDATE above left untouched) -- otherwise topTags()'s "reuse existing tags" list never
      // learns a tag this pass introduced, encouraging synonym drift across enrichment rewrites.
      if (!pinned && !tagsEqual(capability.tags, rewritten.tags)) {
        try {
          await bumpTags(deps.pool, rewritten.tags);
        } catch (error) {
          console.warn(JSON.stringify({ runId: lease.runId, enrichBumpTagsFailed: error instanceof Error ? error.message : String(error), capabilityId: capability.id }));
        }
      }
      // M3.7 controller ruling: the write-back above deliberately never touches notified_at (a
      // background rewrite must never re-push), but that means the phone card would otherwise
      // keep showing the pre-enrichment summary forever unless it's edited in place. Best-effort
      // and non-fatal -- the enrich write-back above already succeeded regardless of whether this
      // edit does; deps.notifyEnriched (lib/telegram/decide.ts's editCardAfterEnrich) is itself
      // contracted not to throw, this try/catch is belt-and-braces only.
      if (deps.notifyEnriched) {
        try {
          await deps.notifyEnriched(capability.id, t.signal);
        } catch (error) {
          console.warn(JSON.stringify({ runId: lease.runId, enrichNotifyFailed: error instanceof Error ? error.message : String(error), capabilityId: capability.id }));
        }
      }
    }

    return { capabilityId: capability.id };
  } catch (error) {
    // A run that blew the overall 3-minute cap is reported as TIMEOUT regardless of which step
    // was mid-flight, same treatment as runDeepAnalysis's overall cap (deep.ts).
    if (t.timedOut()) throw new ProviderError("TIMEOUT", { cause: error });
    throw error;
  } finally {
    t.clear();
  }
}
