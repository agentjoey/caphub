import type { Pool } from "pg";
import type { Config, Pipeline } from "../config";
import { createDeepSeekCall } from "../providers/deepseek";
import { ProviderError } from "../providers/errors";
import { createMiniMaxCall } from "../providers/minimax";
import { createMiniMaxSearch, type SearchCall } from "../providers/minimax-search";
import { createTavilySearch } from "../providers/tavily";
import { enqueueEnrichRun, type Lease } from "../queue/runs";
import type { ObjectStore } from "../storage/s3";
import { RunBudget } from "./budget";
import { upsertCapability } from "./capabilities";
import { extractionSchema, type CapabilityType, type Extraction } from "./card";
import { embedMaterialQuery } from "./material-embedding";
import { prepareMaterial, type MaterialDeps } from "./material";
import { reasonPrompt, searchQuery, visionPrompt } from "./prompts";
import { cardSchemaFor, loadScenarios } from "./scenarios";
import { findSimilar, similarByEmbedding, type SimilarCandidate } from "./similar";
import { recordStep } from "./steps";
import { runStructured, withTimeout, type StructuredCall } from "./structured";
import { bumpTags, topTags } from "./tags";
import { decideVerdict } from "./verdict";

export const TIMEOUTS = { vision: 60_000, search: 60_000, reason: 120_000, review: 120_000 } as const;

export interface PipelineDeps {
  pool: Pool; objects: ObjectStore; vision: StructuredCall; search: SearchCall; reason: StructuredCall;
  material: MaterialDeps; threshold: number;
  /**
   * A throwaway query embedding for overlap-candidate lookup only (see `loadSimilar` below) --
   * never the capability's own `embedding` column, which the separate embed worker tick owns
   * exclusively. Optional and non-fatal by contract: implementations must resolve to `null`
   * rather than reject/throw (see material-embedding.ts's `embedMaterialQuery`, which
   * `createPipelineDeps` wires up here).
   */
  embedQuery: (text: string, signal: AbortSignal) => Promise<number[] | null>;
}

export function createPipelineDeps(config: Config, pool: Pool, objects: ObjectStore, pipeline: Pipeline): PipelineDeps {
  const { minimaxApiKey, deepseekApiKey, tavilyApiKey, geminiApiKey } = config.providers;
  if (!minimaxApiKey) throw new Error("MINIMAX_API_KEY is required to run analysis");
  const minimax = createMiniMaxCall({ apiKey: minimaxApiKey });
  const embedQuery = (text: string, signal: AbortSignal) => embedMaterialQuery(geminiApiKey, text, signal);
  if (pipeline === "mixed") {
    if (!tavilyApiKey) throw new Error("TAVILY_API_KEY is required when pipeline is 'mixed'");
    if (!deepseekApiKey) throw new Error("DEEPSEEK_API_KEY is required when pipeline is 'mixed'");
    return {
      pool, objects, vision: minimax,
      search: createTavilySearch({ apiKey: tavilyApiKey }),
      reason: createDeepSeekCall({ apiKey: deepseekApiKey }),
      material: {}, threshold: config.verdictAutoThreshold, embedQuery
    };
  }
  if (pipeline === "minimax_tavily") {
    if (!tavilyApiKey) throw new Error("TAVILY_API_KEY is required when pipeline is 'minimax_tavily'");
    return {
      pool, objects, vision: minimax,
      search: createTavilySearch({ apiKey: tavilyApiKey }),
      reason: minimax,
      material: {}, threshold: config.verdictAutoThreshold, embedQuery
    };
  }
  return {
    pool, objects, vision: minimax, search: createMiniMaxSearch({ apiKey: minimaxApiKey }), reason: minimax,
    material: {}, threshold: config.verdictAutoThreshold, embedQuery
  };
}

/**
 * The capability's `type`, but only when a human pinned it (`type_by = 'human'`) — via 改建议
 * (see lib/library/actions.ts's editSuggestion). Null for a capture with no capability row yet,
 * or one whose type is still `auto`, in which case a rerun is free to re-derive `type` as usual.
 */
async function loadPinnedType(pool: Pick<Pool, "query">, captureId: string): Promise<CapabilityType | null> {
  const row = (await pool.query<{ type: CapabilityType }>(
    "SELECT type FROM caphub_v2.capabilities WHERE capture_id = $1 AND type_by = 'human'", [captureId]
  )).rows[0];
  return row?.type ?? null;
}

/**
 * This capture's existing capability row, if any, and whether it already has an embedding.
 * A brand-new capture (its first analysis run) has no capability row yet, so `null` here always
 * means "use the text-based similar.ts fallback" (see `loadSimilar` below) -- the embedding
 * worker tick only ever runs against a capability row that already exists.
 */
async function loadExistingCapability(pool: Pick<Pool, "query">, captureId: string): Promise<{ id: string; hasEmbedding: boolean } | null> {
  const row = (await pool.query<{ id: string; has_embedding: boolean }>(
    "SELECT id, embedding IS NOT NULL AS has_embedding FROM caphub_v2.capabilities WHERE capture_id = $1", [captureId]
  )).rows[0];
  return row ? { id: row.id, hasEmbedding: row.has_embedding } : null;
}

/**
 * Candidate cards for both the "similar capabilities" prompt context and overlap-relation
 * detection. In priority order:
 *  1. The vector search against this capture's own stored capability embedding
 *     (`similarByEmbedding({ capabilityId })`), once it has one -- from its second analysis run
 *     onward, after the embedding worker tick has caught up.
 *  2. Otherwise, a throwaway *query* embedding of the material itself (`embedQuery`, e.g. via
 *     Gemini), so overlap candidates are still semantic on a capture's very first run rather
 *     than text-matched only. This embedding is never persisted -- see `embedQuery`'s contract
 *     on PipelineDeps -- and, being an embedding call rather than a reasoning call, it is
 *     deliberately kept OUT of `budget` (the analysis run's 4-call/200k-token cap): it is called
 *     directly here, never through `runStructured`/`runSearch`, so it never touches
 *     `budget.assertCanCall()`/`budget.charge()` (same treatment the embed tick's own calls get).
 *     `embedQuery` is optional/non-fatal by contract (null on no key, provider error or
 *     timeout), so a Gemini outage falls through to (3) rather than failing the run.
 *  3. The existing text-based search (`findSimilar`), when neither of the above has anything to
 *     compare against.
 *
 * `analysis_steps.step`'s CHECK (widened by migration 010 to add 'plan'/'synthesize') does not
 * include 'embed' -- adding it was out of scope for this fix -- so step (2) is logged to stdout
 * instead of recorded as a step row.
 */
async function loadSimilar(
  pool: Pick<Pool, "query">, existing: { id: string; hasEmbedding: boolean } | null, seed: string, captureId: string,
  embedQuery: PipelineDeps["embedQuery"], signal: AbortSignal, runId: string
): Promise<SimilarCandidate[]> {
  if (existing?.hasEmbedding) return similarByEmbedding(pool, { capabilityId: existing.id });
  // `embedQuery` is contractually non-fatal (see PipelineDeps), but this belt-and-braces
  // try/catch guarantees "the analysis must never fail because this lookup failed" even
  // against a misbehaving implementation, rather than relying solely on that contract.
  let embedding: number[] | null = null;
  try {
    embedding = await embedQuery(seed, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`analysis: material embedding lookup threw unexpectedly, falling back to text-similarity candidates (${message})`);
  }
  console.log(JSON.stringify({ runId, step: "embed", ok: embedding !== null }));
  if (embedding) return similarByEmbedding(pool, { embedding, excludeCaptureId: captureId });
  return findSimilar(pool, seed, captureId);
}

async function runSearch(deps: PipelineDeps, runId: string, query: string, budget: RunBudget, signal: AbortSignal) {
  if (!query.trim()) return { sources: [] };
  budget.assertCanCall();
  budget.calls += 1;
  const started = Date.now();
  const base = { runId, step: "search" as const, provider: deps.search.provider, model: deps.search.model, attempt: 1 };
  const t = withTimeout(signal, TIMEOUTS.search);
  let out: Awaited<ReturnType<SearchCall["search"]>>;
  try {
    out = await deps.search.search(query, t.signal);
  } catch (error) {
    const code = t.timedOut() ? "TIMEOUT" : error instanceof ProviderError ? error.code : "UNAVAILABLE";
    await recordStep(deps.pool, { ...base, durationMs: Date.now() - started, ok: false, error: code });
    // 搜索失败通常不致命：记录后继续，reason 仍可基于素材给卡。
    // 但预算耗尽或运行被取消必须终止整个 run，而不是悄悄吞掉。
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

export async function runPipeline(deps: PipelineDeps, lease: Lease, signal: AbortSignal): Promise<{ capabilityId: string; verdict: string }> {
  const capture = (await deps.pool.query<{ kind: "image" | "text" | "url"; object_key: string | null; mime_type: string | null; text: string | null; url: string | null }>(
    "SELECT kind, object_key, mime_type, text, url FROM caphub_v2.captures WHERE id = $1", [lease.captureId])).rows[0];
  if (!capture) throw Object.assign(new Error("CAPTURE_NOT_FOUND"), { code: "CAPTURE_NOT_FOUND" });
  let bytes: Uint8Array | null = null;
  if (capture.kind === "image") {
    // schema CHECK guarantees captures.object_key is set for kind = 'image'.
    const key = capture.object_key!;
    try {
      bytes = await deps.objects.get({ key, digest: key.split("/")[2], bytes: 0 });
    } catch (error) {
      throw Object.assign(new Error("OBJECT_UNAVAILABLE"), { code: "OBJECT_UNAVAILABLE", cause: error });
    }
  }
  const material = await prepareMaterial({ kind: capture.kind, bytes: bytes ?? undefined, text: capture.text, url: capture.url }, deps.material, signal);
  const budget = new RunBudget();

  let extraction: Extraction | null = null;
  if (material.kind === "image") {
    extraction = await runStructured({
      pool: deps.pool, runId: lease.runId, step: "vision", call: deps.vision,
      prompt: visionPrompt(material.ocrText), images: [{ data: material.png, mediaType: "image/png" }],
      schemaName: "extraction", schema: extractionSchema, budget, timeoutMs: TIMEOUTS.vision, signal
    });
  }

  const search = await runSearch(deps, lease.runId, searchQuery(extraction, material), budget, signal);
  const similarSeed = extraction?.what ?? (material.kind === "text" ? material.text : material.kind === "url" ? material.text ?? material.url : "");
  const [existing, existingTags, scenarios, pinnedType] = await Promise.all([
    loadExistingCapability(deps.pool, lease.captureId), topTags(deps.pool), loadScenarios(deps.pool), loadPinnedType(deps.pool, lease.captureId)
  ]);
  const similar = await loadSimilar(deps.pool, existing, similarSeed, lease.captureId, deps.embedQuery, signal, lease.runId);
  if (!scenarios.length) throw new Error("no scenarios configured in caphub_v2.scenarios; cannot run reason step");

  // overlap.target is narrowed to exactly the serial codes offered in the prompt's candidate
  // list (see prompts.ts's reasonPrompt and scenarios.ts's cardSchemaFor/overlapFieldFor) --
  // a candidate with no serial yet (formatSerial returns null) can be shown but never cited.
  const overlapCandidates = similar.map((s) => s.code).filter((code): code is string => code !== null);

  // The pinned type is enforced at the schema layer (cardSchemaFor narrows `type` to a
  // z.literal of it), not by mutating `card.type` after parsing: `refineCard` is what checks
  // `playbook.kind` agrees with `type` (e.g. `experience` requires an `experience`-shaped
  // playbook), so narrowing here makes a disobedient model's mismatched playbook fail
  // validation and retry via the existing invalid-output retry path, instead of silently
  // storing a card whose type and playbook shape disagree.
  const card = await runStructured({
    pool: deps.pool, runId: lease.runId, step: "reason", call: deps.reason,
    prompt: reasonPrompt({ material, extraction, sources: search.sources, similar, existingTags, scenarios, pinnedType }),
    schemaName: "capability_card", schema: cardSchemaFor(scenarios.map((s) => s.slug), pinnedType ?? undefined, overlapCandidates),
    budget, timeoutMs: TIMEOUTS.reason, signal
  });
  // Belt-and-braces only: validation above already guarantees card.type === pinnedType when
  // pinnedType is set (z.literal), so this is a no-op assignment, not the enforcement itself.
  if (pinnedType) card.type = pinnedType;

  const decision = decideVerdict(card, deps.threshold);
  // The card and its tag counts are saved atomically: a failing tag bump must not leave a kept card behind.
  const db = await deps.pool.connect();
  try {
    await db.query("BEGIN");
    const stored = await upsertCapability(db, { captureId: lease.captureId, runId: lease.runId, card, verdict: decision.verdict, verdictBy: decision.by });
    const enteringKeep = stored.verdict === "keep" && stored.previousVerdict !== "keep" && !stored.deleted;
    if (enteringKeep) await bumpTags(db, card.tags);
    await db.query("COMMIT");
    // Queued outside the transaction just committed above (via deps.pool, a separate
    // connection): a losing race against another enqueue for the same capture surfaces as
    // 23505 inside enqueueEnrichRun's own try/catch, and swallowing that *inside* the
    // transaction would abort it (Postgres marks a transaction failed on any error until
    // ROLLBACK, even one caught in application code) -- see migration 011's
    // analysis_runs_one_active_enrich.
    if (stored.verdict === "keep" && stored.enrichedAt === null) {
      await enqueueEnrichRun(deps.pool, lease.captureId, lease.pipeline);
    }
    return { capabilityId: stored.id, verdict: stored.verdict };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
