import type { Pool } from "pg";
import type { Config, Pipeline } from "../config";
import { createDeepSeekCall } from "../providers/deepseek";
import { ProviderError } from "../providers/errors";
import { createMiniMaxCall } from "../providers/minimax";
import { createMiniMaxSearch, type SearchCall } from "../providers/minimax-search";
import { createTavilySearch } from "../providers/tavily";
import type { Lease } from "../queue/runs";
import type { ObjectStore } from "../storage/s3";
import { RunBudget } from "./budget";
import { upsertCapability } from "./capabilities";
import { cardSchema, extractionSchema, type Extraction } from "./card";
import { prepareMaterial, type MaterialDeps } from "./material";
import { reasonPrompt, searchQuery, visionPrompt } from "./prompts";
import { findSimilar } from "./similar";
import { recordStep } from "./steps";
import { runStructured, withTimeout, type StructuredCall } from "./structured";
import { bumpTags, topTags } from "./tags";
import { decideVerdict } from "./verdict";

export const TIMEOUTS = { vision: 60_000, search: 60_000, reason: 120_000, review: 120_000 } as const;

export interface PipelineDeps {
  pool: Pool; objects: ObjectStore; vision: StructuredCall; search: SearchCall; reason: StructuredCall;
  material: MaterialDeps; threshold: number;
}

export function createPipelineDeps(config: Config, pool: Pool, objects: ObjectStore, pipeline: Pipeline): PipelineDeps {
  const { minimaxApiKey, deepseekApiKey, tavilyApiKey } = config.providers;
  if (!minimaxApiKey) throw new Error("MINIMAX_API_KEY is required to run analysis");
  const minimax = createMiniMaxCall({ apiKey: minimaxApiKey });
  if (pipeline === "mixed") {
    if (!tavilyApiKey) throw new Error("TAVILY_API_KEY is required when pipeline is 'mixed'");
    if (!deepseekApiKey) throw new Error("DEEPSEEK_API_KEY is required when pipeline is 'mixed'");
    return {
      pool, objects, vision: minimax,
      search: createTavilySearch({ apiKey: tavilyApiKey }),
      reason: createDeepSeekCall({ apiKey: deepseekApiKey }),
      material: {}, threshold: config.verdictAutoThreshold
    };
  }
  return { pool, objects, vision: minimax, search: createMiniMaxSearch({ apiKey: minimaxApiKey }), reason: minimax, material: {}, threshold: config.verdictAutoThreshold };
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
  const [similar, existingTags] = await Promise.all([findSimilar(deps.pool, similarSeed, lease.captureId), topTags(deps.pool)]);

  const card = await runStructured({
    pool: deps.pool, runId: lease.runId, step: "reason", call: deps.reason,
    prompt: reasonPrompt({ material, extraction, sources: search.sources, similar, existingTags }),
    schemaName: "capability_card", schema: cardSchema, budget, timeoutMs: TIMEOUTS.reason, signal
  });

  const decision = decideVerdict(card, deps.threshold);
  // The card and its tag counts are saved atomically: a failing tag bump must not leave a kept card behind.
  const db = await deps.pool.connect();
  try {
    await db.query("BEGIN");
    const stored = await upsertCapability(db, { captureId: lease.captureId, runId: lease.runId, card, verdict: decision.verdict, verdictBy: decision.by });
    const enteringKeep = stored.verdict === "keep" && stored.previousVerdict !== "keep" && !stored.deleted;
    if (enteringKeep) await bumpTags(db, card.tags);
    await db.query("COMMIT");
    return { capabilityId: stored.id, verdict: stored.verdict };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
