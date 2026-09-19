import type { Pool, PoolClient } from "pg";
import { capabilityTypeSchema, isValidTag, type CapabilityType } from "../analysis/card";
import { bumpTags } from "../analysis/tags";
import type { Pipeline } from "../config";
import { newId } from "../ids";

export type ActionResult =
  | { ok: true; updatedAt: string }
  | { ok: false; reason: "CONFLICT" | "NOT_FOUND" | "INVALID" | "OBJECT_GONE"; message: string };

const conflict = (message = "已在别处处理"): ActionResult => ({ ok: false, reason: "CONFLICT", message });
const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

async function tx<T>(pool: Pool, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const r = await fn(db);
    await db.query("COMMIT");
    return r;
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

async function missingOrConflict(db: Pick<Pool, "query">, id: string): Promise<ActionResult> {
  const r = await db.query("SELECT 1 FROM caphub_v2.capabilities WHERE id = $1 AND deleted_at IS NULL", [id]);
  return r.rows.length ? conflict() : { ok: false, reason: "NOT_FOUND", message: "卡片不存在或已删除" };
}

export function decide(pool: Pool, input: { id: string; expectedUpdatedAt: string; verdict: "keep" | "discard" }): Promise<ActionResult> {
  return tx(pool, async (db) => {
    const r = await db.query<{ updated_at: Date; tags: string[]; previous: string }>(
      `UPDATE caphub_v2.capabilities cb SET verdict = $3, verdict_by = 'human', verdict_at = now(), updated_at = now()
       FROM (SELECT verdict AS previous FROM caphub_v2.capabilities WHERE id = $1) prev
       WHERE cb.id = $1 AND cb.updated_at = $2 AND cb.deleted_at IS NULL
       RETURNING cb.updated_at, cb.tags, prev.previous`,
      [input.id, input.expectedUpdatedAt, input.verdict]);
    const row = r.rows[0];
    if (!row) return missingOrConflict(db, input.id);
    if (input.verdict === "keep" && row.previous !== "keep") await bumpTags(db, row.tags);
    return { ok: true, updatedAt: iso(row.updated_at) };
  });
}

export function editSuggestion(pool: Pool, input: { id: string; expectedUpdatedAt: string; type: CapabilityType; usage: "integrate" | "reference"; tags: string[] }): Promise<ActionResult> {
  const tags = [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  const bad = tags.filter((t) => !isValidTag(t));
  if (!capabilityTypeSchema.safeParse(input.type).success || !["integrate", "reference"].includes(input.usage)) {
    return Promise.resolve({ ok: false, reason: "INVALID", message: "类型或用法不合法" });
  }
  if (bad.length || tags.length < 1 || tags.length > 6) {
    return Promise.resolve({ ok: false, reason: "INVALID", message: bad.length ? `标签不合法：${bad.join("、")}（需英文小写，可用连字符）` : "标签需 1–6 个" });
  }
  return tx(pool, async (db) => {
    const r = await db.query<{ updated_at: Date; tags: string[]; previous: string }>(
      `UPDATE caphub_v2.capabilities cb SET type = $3, usage = $4, tags = $5, verdict = 'keep', verdict_by = 'human', verdict_at = now(), updated_at = now()
       FROM (SELECT verdict AS previous FROM caphub_v2.capabilities WHERE id = $1) prev
       WHERE cb.id = $1 AND cb.updated_at = $2 AND cb.deleted_at IS NULL
       RETURNING cb.updated_at, cb.tags, prev.previous`,
      [input.id, input.expectedUpdatedAt, input.type, input.usage, tags]);
    const row = r.rows[0];
    if (!row) return missingOrConflict(db, input.id);
    if (row.previous !== "keep") await bumpTags(db, tags);
    return { ok: true, updatedAt: iso(row.updated_at) };
  });
}

export async function softDelete(pool: Pool, input: { id: string; expectedUpdatedAt: string }): Promise<ActionResult> {
  const r = await pool.query<{ updated_at: Date }>(
    `UPDATE caphub_v2.capabilities SET deleted_at = now(), updated_at = now()
     WHERE id = $1 AND updated_at = $2 AND deleted_at IS NULL RETURNING updated_at`, [input.id, input.expectedUpdatedAt]);
  return r.rows[0] ? { ok: true, updatedAt: iso(r.rows[0].updated_at) } : missingOrConflict(pool, input.id);
}

export async function requestRerun(pool: Pool, input: { captureId: string; pipeline: Pipeline }): Promise<ActionResult> {
  const c = (await pool.query<{ kind: string; purged: boolean; active: boolean }>(
    `SELECT c.kind,
            EXISTS (SELECT 1 FROM caphub_v2.retention t WHERE t.object_key = c.object_key AND t.purged_at IS NOT NULL) AS purged,
            EXISTS (SELECT 1 FROM caphub_v2.analysis_runs r WHERE r.capture_id = c.id AND r.state IN ('queued','running')) AS active
     FROM caphub_v2.captures c WHERE c.id = $1`, [input.captureId])).rows[0];
  if (!c) return { ok: false, reason: "NOT_FOUND", message: "投递记录不存在" };
  if (c.kind === "image" && c.purged) return { ok: false, reason: "OBJECT_GONE", message: "原图已过期，无法重跑" };
  if (c.active) return conflict("已在排队或分析中");
  await pool.query("INSERT INTO caphub_v2.analysis_runs (id, capture_id, pipeline, state) VALUES ($1, $2, $3, 'queued')",
    [newId("run"), input.captureId, input.pipeline]);
  return { ok: true, updatedAt: new Date().toISOString() };
}

export async function requestReview(pool: Pool, input: { id: string }): Promise<ActionResult> {
  const r = await pool.query<{ id: string }>(
    `UPDATE caphub_v2.capabilities SET review_requested_at = now(), review_error = NULL
     WHERE id = $1 AND deleted_at IS NULL AND review_requested_at IS NULL RETURNING id`, [input.id]);
  return r.rows[0] ? { ok: true, updatedAt: new Date().toISOString() } : conflict("复核已在进行中");
}
