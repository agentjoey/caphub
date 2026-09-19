import type { Pool } from "pg";
import type { CapabilityType, Playbook, ReviewNote } from "../analysis/card";

export const PAGE_SIZE = 20;
type Q = Pick<Pool, "query">;

const CARD_COLUMNS = `
  cb.id, cb.capture_id AS "captureId", cb.title, cb.type, cb.summary, cb.signals,
  cb.suggested_verdict AS "suggestedVerdict", cb.suggested_reason AS "suggestedReason", cb.confidence,
  cb.verdict, cb.verdict_by AS "verdictBy", cb.usage, cb.playbook, cb.tags, cb.source_url AS "sourceUrl",
  cb.review_note AS "reviewNote", cb.review_requested_at AS "reviewRequestedAt", cb.review_error AS "reviewError",
  cb.synced_at AS "syncedAt", cb.deleted_at AS "deletedAt", cb.created_at AS "createdAt", cb.updated_at AS "updatedAt",
  json_build_object('kind', c.kind, 'objectKey', c.object_key, 'text', c.text, 'url', c.url) AS capture`;

export interface CapabilityRow {
  id: string; captureId: string; title: string; type: CapabilityType; summary: string; signals: string[];
  suggestedVerdict: "keep" | "discard"; suggestedReason: string; confidence: number;
  verdict: "keep" | "discard" | "pending"; verdictBy: "auto" | "human" | null;
  usage: "integrate" | "reference"; playbook: Playbook; tags: string[]; sourceUrl: string | null;
  reviewNote: ReviewNote | null; reviewRequestedAt: string | null; reviewError: string | null;
  syncedAt: string | null; deletedAt: string | null; createdAt: string; updatedAt: string;
  capture: { kind: "image" | "text" | "url"; objectKey: string | null; text: string | null; url: string | null };
}

function toIso<T extends object>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) if (v instanceof Date) out[k] = v.toISOString();
  return out as unknown as T;
}

async function paged(pool: Q, where: string, values: unknown[], page: number) {
  const p = Math.max(1, Math.floor(page) || 1);
  const n = values.length;
  const items = (await pool.query<CapabilityRow>(
    `SELECT ${CARD_COLUMNS} FROM caphub_v2.capabilities cb JOIN caphub_v2.captures c ON c.id = cb.capture_id
     WHERE ${where} ORDER BY cb.created_at DESC LIMIT $${n + 1} OFFSET $${n + 2}`,
    [...values, PAGE_SIZE, (p - 1) * PAGE_SIZE])).rows.map(toIso);
  const total = Number((await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM caphub_v2.capabilities cb WHERE ${where}`, values)).rows[0]?.total ?? 0);
  return { items, total };
}

export function listPending(pool: Q, opts: { page: number }) {
  return paged(pool, "cb.verdict = 'pending' AND cb.deleted_at IS NULL", [], opts.page);
}

export interface LibraryFilter { q?: string; types?: CapabilityType[]; tags?: string[]; usage?: "integrate" | "reference"; discarded?: boolean; page: number }

export function listLibrary(pool: Q, f: LibraryFilter) {
  const clauses = [`cb.verdict = '${f.discarded ? "discard" : "keep"}'`, "cb.deleted_at IS NULL"];
  const values: unknown[] = [];
  const add = (sql: (i: number) => string, v: unknown) => { values.push(v); clauses.push(sql(values.length)); };
  if (f.q?.trim()) add((i) => `cb.search @@ websearch_to_tsquery('simple', $${i})`, f.q.trim());
  if (f.types?.length) add((i) => `cb.type = ANY($${i})`, f.types);
  if (f.tags?.length) add((i) => `cb.tags @> $${i}`, f.tags);
  if (f.usage) add((i) => `cb.usage = $${i}`, f.usage);
  return paged(pool, clauses.join(" AND "), values, f.page);
}

export interface LibraryStats { byType: Record<CapabilityType, number>; total: number; tagCount: number; pending: number }

export async function libraryStats(pool: Q): Promise<LibraryStats> {
  const byType: Record<CapabilityType, number> = { skill: 0, experience: 0, plugin: 0, prompt: 0, other: 0 };
  const rows = (await pool.query<{ type: CapabilityType; n: string }>(
    "SELECT type, count(*)::text AS n FROM caphub_v2.capabilities WHERE verdict = 'keep' AND deleted_at IS NULL GROUP BY type")).rows;
  for (const r of rows) byType[r.type] = Number(r.n);
  const tagCount = Number((await pool.query<{ n: string }>(
    "SELECT count(DISTINCT t)::text AS n FROM caphub_v2.capabilities, unnest(tags) AS t WHERE verdict = 'keep' AND deleted_at IS NULL")).rows[0]?.n ?? 0);
  const pending = Number((await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM caphub_v2.capabilities WHERE verdict = 'pending' AND deleted_at IS NULL")).rows[0]?.n ?? 0);
  return { byType, total: Object.values(byType).reduce((a, b) => a + b, 0), tagCount, pending };
}

export async function allTags(pool: Q): Promise<Array<{ name: string; count: number }>> {
  const r = await pool.query<{ name: string; count: string }>(
    `SELECT t AS name, count(*)::text AS count FROM caphub_v2.capabilities, unnest(tags) AS t
     WHERE verdict = 'keep' AND deleted_at IS NULL GROUP BY t ORDER BY count(*) DESC, t LIMIT 200`);
  return r.rows.map((x) => ({ name: x.name, count: Number(x.count) }));
}

export interface StepSummary { step: string; provider: string; model: string; attempt: number; ok: boolean; error: string | null; durationMs: number; inputTokens: number | null; outputTokens: number | null }
export interface CapabilityDetail extends CapabilityRow { steps: StepSummary[]; sources: Array<{ title: string; url: string }>; runPipeline: string; runState: string; runId: string }

export async function getCapabilityDetail(pool: Q, id: string): Promise<CapabilityDetail | null> {
  const row = (await pool.query<CapabilityRow & { runPipeline: string; runState: string; runId: string }>(
    `SELECT ${CARD_COLUMNS}, r.pipeline AS "runPipeline", r.state AS "runState", r.id AS "runId"
     FROM caphub_v2.capabilities cb JOIN caphub_v2.captures c ON c.id = cb.capture_id
     JOIN caphub_v2.analysis_runs r ON r.id = cb.run_id WHERE cb.id = $1`, [id])).rows[0];
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
