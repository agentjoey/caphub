import type { Pool } from "pg";
import type { Config, Pipeline } from "../config";
import { createDeepSeekCall } from "../providers/deepseek";
import { ProviderError } from "../providers/errors";
import { createMiniMaxCall } from "../providers/minimax";
import { createMiniMaxSearch, type SearchCall } from "../providers/minimax-search";
import { createTavilySearch } from "../providers/tavily";
import { enqueueEnrichRun, type Lease } from "../queue/runs";
import type { ObjectStore } from "../storage/s3";
import { createGeminiVideoCall } from "../providers/gemini-video";
import { RunBudget } from "./budget";
import { upsertCapability } from "./capabilities";
import { extractionSchema, videoExtractionSchema, VIDEO_CLIP_SEC, type CapabilityType, type Extraction } from "./card";
import { embedMaterialQuery } from "./material-embedding";
import { fetchYouTubeMeta } from "./material/youtube";
import { prepareMaterial, type MaterialDeps } from "./material";
import { collectPrompts } from "./prompt-locate";
import { reasonPrompt, searchQuery, videoPrompt, visionPrompt } from "./prompts";
import { cardSchemaFor, loadScenarios } from "./scenarios";
import { findSimilar, similarByEmbedding, type SimilarCandidate } from "./similar";
import { recordStep } from "./steps";
import { runStructured, withTimeout, type StructuredCall } from "./structured";
import { bumpTags, topTags } from "./tags";
import { decideVerdict } from "./verdict";

export const TIMEOUTS = { vision: 60_000, search: 60_000, reason: 120_000, review: 120_000, video: 300_000 } as const;

/** Budget for a video analysis run: the video call itself is far larger than an image/text one, so it gets its own, roomier cap (Task 4). */
export const VIDEO_BUDGET = { maxCalls: 4, maxTokens: 600_000 } as const;

export interface PipelineDeps {
  pool: Pool; objects: ObjectStore; vision: StructuredCall; search: SearchCall; reason: StructuredCall;
  /** The Gemini video-understanding call (lib/providers/gemini-video.ts); undefined when no Gemini key is configured -- a video analysis then falls back to metadata-only (see runPipeline). */
  video?: StructuredCall;
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
  const { minimaxApiKey, deepseekApiKey, tavilyApiKey, geminiApiKey, youtubeApiKey } = config.providers;
  if (!minimaxApiKey) throw new Error("MINIMAX_API_KEY is required to run analysis");
  const minimax = createMiniMaxCall({ apiKey: minimaxApiKey });
  const embedQuery = (text: string, signal: AbortSignal) => embedMaterialQuery(geminiApiKey, text, signal);
  const video = geminiApiKey ? createGeminiVideoCall({ apiKey: geminiApiKey, model: config.geminiVideoModel }) : undefined;
  const material: MaterialDeps = { youtubeApiKey };
  if (pipeline === "mixed") {
    if (!tavilyApiKey) throw new Error("TAVILY_API_KEY is required when pipeline is 'mixed'");
    if (!deepseekApiKey) throw new Error("DEEPSEEK_API_KEY is required when pipeline is 'mixed'");
    return {
      pool, objects, vision: minimax, video,
      search: createTavilySearch({ apiKey: tavilyApiKey }),
      reason: createDeepSeekCall({ apiKey: deepseekApiKey }),
      material, threshold: config.verdictAutoThreshold, embedQuery
    };
  }
  if (pipeline === "minimax_tavily") {
    if (!tavilyApiKey) throw new Error("TAVILY_API_KEY is required when pipeline is 'minimax_tavily'");
    return {
      pool, objects, vision: minimax, video,
      search: createTavilySearch({ apiKey: tavilyApiKey }),
      reason: minimax,
      material, threshold: config.verdictAutoThreshold, embedQuery
    };
  }
  return {
    pool, objects, vision: minimax, video, search: createMiniMaxSearch({ apiKey: minimaxApiKey }), reason: minimax,
    material, threshold: config.verdictAutoThreshold, embedQuery
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
  let material = await prepareMaterial({ kind: capture.kind, bytes: bytes ?? undefined, text: capture.text, url: capture.url }, deps.material, signal);
  const budget = new RunBudget(material.kind === "video" ? VIDEO_BUDGET : undefined);

  let extraction: Extraction | null = null;
  // Forces the eventual verdict to pending (below) rather than running decideVerdict against a
  // card built from metadata alone: a video whose content couldn't be read (no Gemini key, or
  // the call itself failing) always needs a human look, never an auto-keep/auto-discard.
  let videoFailed = false;
  if (material.kind === "video") {
    const started = Date.now();
    const meta = await fetchYouTubeMeta(material.videoId, deps.material.youtubeApiKey, deps.material.fetch, signal);
    await recordStep(deps.pool, { runId: lease.runId, step: "fetch", provider: "youtube", model: "data-api-v3", attempt: 1, durationMs: Date.now() - started, ok: meta !== null, output: meta });
    material = { ...material, meta };
    const clipped = (meta?.durationSec ?? 0) > VIDEO_CLIP_SEC;
    if (!deps.video) {
      videoFailed = true;
    } else {
      try {
        extraction = await runStructured({
          pool: deps.pool, runId: lease.runId, step: "vision", call: deps.video,
          prompt: videoPrompt(meta, clipped), video: { url: material.url, ...(clipped ? { endOffsetSec: VIDEO_CLIP_SEC } : {}) },
          schemaName: "video_extraction", schema: videoExtractionSchema, budget, timeoutMs: TIMEOUTS.video, signal
        });
      } catch (error) {
        // Budget exhaustion and cancellation must still end the run; anything else (private /
        // removed video, Gemini outage) falls back to a metadata-only analysis sent to Review.
        if (error instanceof ProviderError && (error.code === "BUDGET" || error.code === "ABORTED")) throw error;
        videoFailed = true;
      }
    }
  } else if (material.kind === "image") {
    extraction = await runStructured({
      pool: deps.pool, runId: lease.runId, step: "vision", call: deps.vision,
      prompt: visionPrompt(material.ocrText), images: [{ data: material.png, mediaType: "image/png" }],
      schemaName: "extraction", schema: extractionSchema, budget, timeoutMs: TIMEOUTS.vision, signal
    });
  }

  const search = await runSearch(deps, lease.runId, searchQuery(extraction, material), budget, signal);
  const similarSeed = extraction?.what ?? (material.kind === "text" ? material.text
    : material.kind === "url" ? material.text ?? material.url
    : material.kind === "video" ? material.meta?.title ?? material.url : "");
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

  // Verbatim prompts come from the input source only (spec 2026-09-22): the vision transcription
  // for an image, or the reason step's locators resolved against the same text it was shown.
  const found = collectPrompts({ material, extraction, locators: card.prompt_locators });
  const decision = videoFailed
    ? { verdict: "pending" as const, by: null }
    : decideVerdict(card, deps.threshold, { count: found.prompts.length, unresolved: found.unresolved });
  // The card and its tag counts are saved atomically: a failing tag bump must not leave a kept card behind.
  const db = await deps.pool.connect();
  try {
    await db.query("BEGIN");
    const stored = await upsertCapability(db, {
      captureId: lease.captureId, runId: lease.runId, card, verdict: decision.verdict, verdictBy: decision.by,
      prompts: found.prompts, promptUnresolved: found.unresolved
    });
    const enteringKeep = stored.verdict === "keep" && stored.previousVerdict !== "keep" && !stored.deleted;
    if (enteringKeep) await bumpTags(db, card.tags);
    await db.query("COMMIT");
    // Ruling (M3.7 review, fix round 1): a rerun must re-enrich even when enriched_at is
    // already set. upsertCapability's ON CONFLICT branch overwrites summary/signals/playbook/
    // open_questions on every rerun (it has no idea whether this card was ever enriched), so
    // gating the enqueue on enrichedAt === null would let a rerun permanently strand a card back
    // on the pre-enrichment, process-narrating summary with no way to re-enrich it. The only
    // gates left are verdict = keep and not soft-deleted (`!stored.deleted`, already computed
    // above for enteringKeep) -- migration 011's analysis_runs_one_active_enrich unique index is
    // what stops a duplicate enqueue while one is already queued or running for this capture.
    if (stored.verdict === "keep" && !stored.deleted) {
      // Deliberately its own try/catch, not the one below: this runs *after* COMMIT, so a
      // non-23505 failure here (pool exhaustion, connection drop -- 23505 itself is already
      // swallowed inside enqueueEnrichRun) must never be treated as this analysis run's own
      // failure. Falling through to the catch below would ROLLBACK an already-committed
      // connection and report a false "分析失败" for a card that was in fact stored -- a missed
      // enrich enqueue is recoverable (the next decide/rerun re-enqueues it), a falsely reported
      // analysis failure is not.
      try {
        await enqueueEnrichRun(deps.pool, lease.captureId, lease.pipeline);
      } catch (error) {
        console.warn(JSON.stringify({ runId: lease.runId, enrichEnqueueError: error instanceof Error ? error.message : String(error) }));
      }
    }
    return { capabilityId: stored.id, verdict: stored.verdict };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
