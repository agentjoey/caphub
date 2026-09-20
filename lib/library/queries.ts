import type { Pool } from "pg";
import type { CapabilityType, Playbook, ReviewNote, SourceFacts } from "../analysis/card";
import { type Progress } from "./labels";
import { toVectorLiteral } from "../analysis/embedding";
import { parseSerialQuery } from "./serial";

export const PAGE_SIZE = 20;
/** Minimum cosine similarity for an embedding-only match to count as a search candidate. */
export const SEMANTIC_MIN = 0.65;
type Q = Pick<Pool, "query">;

const CARD_COLUMNS = `
  cb.id, cb.capture_id AS "captureId", cb.title, cb.type, cb.summary, cb.signals,
  cb.suggested_verdict AS "suggestedVerdict", cb.suggested_reason AS "suggestedReason", cb.confidence,
  cb.verdict, cb.verdict_by AS "verdictBy", cb.usage, cb.playbook, cb.tags, cb.source_url AS "sourceUrl",
  cb.serial, cb.scenarios,
  cb.score, cb.score_reason AS "scoreReason", cb.source_facts AS "sourceFacts",
  cb.progress, cb.progress_link AS "progressLink", cb.progress_at AS "progressAt",
  cb.review_note AS "reviewNote", cb.review_requested_at AS "reviewRequestedAt", cb.review_error AS "reviewError",
  cb.synced_at AS "syncedAt", cb.deleted_at AS "deletedAt", cb.created_at AS "createdAt", cb.updated_at AS "updatedAt",
  json_build_object('kind', c.kind, 'objectKey', c.object_key, 'thumbKey', c.thumb_key, 'text', c.text, 'url', c.url) AS capture`;

export interface CapabilityRow {
  id: string; captureId: string; title: string; type: CapabilityType; summary: string; signals: string[];
  suggestedVerdict: "keep" | "discard"; suggestedReason: string; confidence: number;
  verdict: "keep" | "discard" | "pending"; verdictBy: "auto" | "human" | null;
  usage: "integrate" | "reference"; playbook: Playbook; tags: string[]; sourceUrl: string | null;
  serial: number | null; scenarios: string[];
  /** AI value score 1–5, or null for a card scored before M3.5's backfill — the UI must render nothing rather than a 0. */
  score: number | null; scoreReason: string | null; sourceFacts: SourceFacts;
  progress: Progress; progressLink: string | null; progressAt: string | null;
  reviewNote: ReviewNote | null; reviewRequestedAt: string | null; reviewError: string | null;
  syncedAt: string | null; deletedAt: string | null; createdAt: string; updatedAt: string;
  capture: { kind: "image" | "text" | "url"; objectKey: string | null; thumbKey: string | null; text: string | null; url: string | null };
}

/** Escapes ILIKE metacharacters (and the escape char itself) so user input is matched literally. */
function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function toIso<T extends object>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) if (v instanceof Date) out[k] = v.toISOString();
  return out as unknown as T;
}

/**
 * `extra` bolts additional columns (and the join they come from) onto the shared card select for
 * one caller — see {@link listTodoCapabilities}, which also needs each row's latest analysis run.
 */
async function paged<T extends CapabilityRow>(
  pool: Q, where: string, values: unknown[], page: number,
  orderBy = "cb.created_at DESC", extra?: { columns: string; join: string }
) {
  const p = Math.max(1, Math.floor(page) || 1);
  const n = values.length;
  const items = (await pool.query<T>(
    `SELECT ${CARD_COLUMNS}${extra ? `, ${extra.columns}` : ""}
     FROM caphub_v2.capabilities cb JOIN caphub_v2.captures c ON c.id = cb.capture_id
     ${extra?.join ?? ""}
     WHERE ${where} ORDER BY ${orderBy} LIMIT $${n + 1} OFFSET $${n + 2}`,
    [...values, PAGE_SIZE, (p - 1) * PAGE_SIZE])).rows.map(toIso);
  const total = Number((await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM caphub_v2.capabilities cb WHERE ${where}`, values)).rows[0]?.total ?? 0);
  return { items, total };
}

export function listPending(pool: Q, opts: { page: number }) {
  return paged(pool, "cb.verdict = 'pending' AND cb.deleted_at IS NULL", [], opts.page);
}

/**
 * Self-build progress states shown by the Telegram `/todo` command — kept, reference-only cards
 * not yet started. `building` is deliberately excluded (owner ruling, 2026-09-20, reversing an
 * earlier controller ruling): once self-build has begun, the card is "自研中", not "待自研", so it
 * no longer belongs in `/todo` or the library's 待自研 tile. Those cards remain reachable through
 * the library's own progress filter.
 */
export const TODO_PROGRESS: Progress[] = ["todo", "planned"];

/**
 * Reference-card progress states that are still "in the self-build pipeline" at all — wider than
 * {@link TODO_PROGRESS}, since this includes `building`. Used by notify.ts's `isSelfBuildCard` to
 * decide whether a failed analysis rerun should still render as a self-build card (progress line
 * + progress buttons) rather than the bare 分析失败 card — a card already `building` deserves that
 * treatment just as much as one still `todo`/`planned`, even though it no longer belongs in
 * `/todo` or the library's 待自研 tile (see {@link TODO_PROGRESS}).
 */
export const SELF_BUILD_PROGRESS: Progress[] = ["todo", "planned", "building"];

/**
 * A `/todo` row: a card plus the state of its capture's latest analysis run. That run may have
 * failed (a failed *rerun* of an already-decided card leaves the card's own columns holding the
 * previous, successful run's data), which `/todo` notes on the card — see commands.ts.
 */
export interface TodoCapabilityRow extends CapabilityRow {
  lastRunState: string | null;
  lastRunErrorCode: string | null;
}

/** Kept `usage='reference'` cards still awaiting/undergoing self-build — backs the Telegram `/todo` command (commands.ts). */
export function listTodoCapabilities(pool: Q, opts: { page: number }) {
  return paged<TodoCapabilityRow>(
    pool,
    "cb.verdict = 'keep' AND cb.deleted_at IS NULL AND cb.usage = 'reference' AND cb.progress = ANY($1)",
    [TODO_PROGRESS],
    opts.page,
    undefined,
    {
      columns: `lr.state AS "lastRunState", lr.error_code AS "lastRunErrorCode"`,
      join: `LEFT JOIN LATERAL (
       SELECT state, error_code FROM caphub_v2.analysis_runs
       WHERE capture_id = cb.capture_id ORDER BY created_at DESC LIMIT 1
     ) lr ON true`
    }
  );
}

export interface LibraryFilter {
  q?: string; types?: CapabilityType[]; tags?: string[]; scenarios?: string[];
  usage?: "integrate" | "reference"; progress?: Progress[]; discarded?: boolean; page: number;
}

/** Extra context for the `q`-driven hybrid search, computed by the caller (web-only concerns). */
export interface LibrarySearchContext {
  /** L2-normalized query embedding, or null/undefined when unavailable (see embedSearchQuery). */
  queryEmbedding?: number[] | null;
  /** Scenario slugs whose label/keywords match `q` (see matchScenarios). */
  matchedScenarioSlugs?: string[];
}

export function listLibrary(pool: Q, f: LibraryFilter, search: LibrarySearchContext = {}) {
  const clauses = [`cb.verdict = '${f.discarded ? "discard" : "keep"}'`, "cb.deleted_at IS NULL"];
  const values: unknown[] = [];
  const add = (sql: (i: number) => string, v: unknown) => { values.push(v); clauses.push(sql(values.length)); };

  if (f.types?.length) add((i) => `cb.type = ANY($${i})`, f.types);
  if (f.tags?.length) add((i) => `cb.tags @> $${i}`, f.tags);
  if (f.usage) add((i) => `cb.usage = $${i}`, f.usage);
  if (f.scenarios?.length) add((i) => `cb.scenarios && $${i}::text[]`, f.scenarios);
  // progress is only meaningful for usage='reference' cards (usage='integrate' cards default
  // to 'todo' with no self-build meaning), so pin usage here rather than relying on the caller
  // (UI stat tile, future Telegram, etc.) to also pass usage='reference'.
  if (f.progress?.length) add((i) => `cb.usage = 'reference' AND cb.progress = ANY($${i})`, f.progress);

  const q = f.q?.trim();
  const serial = q ? parseSerialQuery(q) : null;

  if (q && serial === null) {
    const vec = search.queryEmbedding ? toVectorLiteral(search.queryEmbedding) : null;
    values.push(vec); const vecIdx = values.length;
    values.push(q); const qIdx = values.length;
    values.push(`%${escapeLike(q)}%`); const ilikeIdx = values.length;
    values.push(search.matchedScenarioSlugs ?? []); const scenIdx = values.length;
    values.push(SEMANTIC_MIN); const minIdx = values.length;

    const semanticSim = `(1 - (cb.embedding <=> $${vecIdx}::vector))`;
    const ftsMatch = `cb.search @@ websearch_to_tsquery('simple', $${qIdx})`;
    const scenarioMatch = `cb.scenarios && $${scenIdx}::text[]`;
    const ilikeMatch = `(cb.title ILIKE $${ilikeIdx} OR cb.summary ILIKE $${ilikeIdx} OR EXISTS (SELECT 1 FROM unnest(cb.tags) tg WHERE tg ILIKE $${ilikeIdx}))`;
    const semanticCandidate = `(cb.embedding IS NOT NULL AND $${vecIdx}::vector IS NOT NULL AND ${semanticSim} >= $${minIdx})`;

    clauses.push(`(${semanticCandidate} OR ${ftsMatch} OR ${scenarioMatch} OR ${ilikeMatch})`);

    const score = `(COALESCE(CASE WHEN cb.embedding IS NOT NULL AND $${vecIdx}::vector IS NOT NULL THEN ${semanticSim} END, 0)` +
      ` + CASE WHEN ${ftsMatch} THEN 0.3 ELSE 0 END` +
      ` + CASE WHEN ${scenarioMatch} THEN 0.25 ELSE 0 END` +
      ` + CASE WHEN ${ilikeMatch} THEN 0.15 ELSE 0 END` +
      ` + CASE WHEN cb.score IS NOT NULL THEN 0.05 * (cb.score - 3) ELSE 0 END)`;

    return paged(pool, clauses.join(" AND "), values, f.page, `${score} DESC, cb.updated_at DESC, cb.id`);
  }

  if (serial !== null) add((i) => `cb.serial = $${i}`, serial);

  return paged(pool, clauses.join(" AND "), values, f.page);
}

export interface LibraryStats { byType: Record<CapabilityType, number>; total: number; tagCount: number; pending: number; toBuild: number }

/**
 * The `progress` values counted by the library stats bar's "待自研" tile — kept, reference-only
 * cards not yet started. Deliberately the *same* set as {@link TODO_PROGRESS} (a card that has
 * entered self-build is "自研中", not "待自研," even though it isn't `done` yet): the tile's count,
 * its filter link, `/todo`'s list and its "更多" link must all describe exactly the same cards,
 * not two subtly different ones.
 */
export const TO_BUILD_PROGRESS: Progress[] = TODO_PROGRESS;

export async function libraryStats(pool: Q): Promise<LibraryStats> {
  const byType: Record<CapabilityType, number> = { skill: 0, experience: 0, plugin: 0, prompt: 0, tool: 0, other: 0 };
  const rows = (await pool.query<{ type: CapabilityType; n: string }>(
    "SELECT type, count(*)::text AS n FROM caphub_v2.capabilities WHERE verdict = 'keep' AND deleted_at IS NULL GROUP BY type")).rows;
  for (const r of rows) byType[r.type] = Number(r.n);
  const tagCount = Number((await pool.query<{ n: string }>(
    "SELECT count(DISTINCT t)::text AS n FROM caphub_v2.capabilities, unnest(tags) AS t WHERE verdict = 'keep' AND deleted_at IS NULL")).rows[0]?.n ?? 0);
  const pending = Number((await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM caphub_v2.capabilities WHERE verdict = 'pending' AND deleted_at IS NULL")).rows[0]?.n ?? 0);
  const toBuild = Number((await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM caphub_v2.capabilities
     WHERE verdict = 'keep' AND deleted_at IS NULL AND usage = 'reference' AND progress = ANY($1)`,
    [TO_BUILD_PROGRESS])).rows[0]?.n ?? 0);
  return { byType, total: Object.values(byType).reduce((a, b) => a + b, 0), tagCount, pending, toBuild };
}

/** Per-scenario counts among currently-visible cards (kept, or discarded when `discarded` is set), for the library's scenario chip row. */
export async function scenarioStats(pool: Q, opts: { discarded?: boolean } = {}): Promise<Array<{ slug: string; count: number }>> {
  const verdict = opts.discarded ? "discard" : "keep";
  const r = await pool.query<{ slug: string; count: string }>(
    `SELECT s AS slug, count(*)::text AS count FROM caphub_v2.capabilities, unnest(scenarios) AS s
     WHERE verdict = $1 AND deleted_at IS NULL GROUP BY s`, [verdict]);
  return r.rows.map((x) => ({ slug: x.slug, count: Number(x.count) }));
}

export async function allTags(pool: Q): Promise<Array<{ name: string; count: number }>> {
  const r = await pool.query<{ name: string; count: string }>(
    `SELECT t AS name, count(*)::text AS count FROM caphub_v2.capabilities, unnest(tags) AS t
     WHERE verdict = 'keep' AND deleted_at IS NULL GROUP BY t ORDER BY count(*) DESC, t LIMIT 200`);
  return r.rows.map((x) => ({ name: x.name, count: Number(x.count) }));
}

export interface StepSummary { step: string; provider: string; model: string; attempt: number; ok: boolean; error: string | null; durationMs: number; inputTokens: number | null; outputTokens: number | null }
export interface CapabilityDetail extends CapabilityRow {
  steps: StepSummary[]; sources: Array<{ title: string; url: string }>; runPipeline: string; runState: string; runId: string;
  /** The original image's retention window, so a purged original's card can point at its thumbnail with an honest date. Null for non-image captures or ones never tracked for retention. */
  retentionEligibleAt: string | null; retentionPurgedAt: string | null;
}

export async function getCapabilityDetail(pool: Q, id: string): Promise<CapabilityDetail | null> {
  const row = (await pool.query<CapabilityRow & { runPipeline: string; runState: string; runId: string; retentionEligibleAt: string | null; retentionPurgedAt: string | null }>(
    `SELECT ${CARD_COLUMNS}, r.pipeline AS "runPipeline", r.state AS "runState", r.id AS "runId",
            ret.eligible_at AS "retentionEligibleAt", ret.purged_at AS "retentionPurgedAt"
     FROM caphub_v2.capabilities cb JOIN caphub_v2.captures c ON c.id = cb.capture_id
     JOIN caphub_v2.analysis_runs r ON r.id = cb.run_id
     LEFT JOIN caphub_v2.retention ret ON ret.object_key = c.object_key
     WHERE cb.id = $1`, [id])).rows[0];
  if (!row) return null;
  const steps = (await pool.query<StepSummary & { output: unknown }>(
    `SELECT step, provider, model, attempt, ok, error, duration_ms AS "durationMs", input_tokens AS "inputTokens",
            output_tokens AS "outputTokens", CASE WHEN step = 'search' AND ok THEN output ELSE NULL END AS output
     FROM caphub_v2.analysis_steps WHERE run_id = $1 ORDER BY id`, [row.runId])).rows;
  const search = steps.find((s) => s.step === "search" && s.ok)?.output as { sources?: Array<{ title: string; url: string }> } | undefined;
  const rest = toIso(row);
  return {
    ...rest,
    steps: steps.map(({ output: _o, ...s }) => { void _o; return s; }),
    sources: (search?.sources ?? []).map((s) => ({ title: s.title, url: s.url }))
  };
}
