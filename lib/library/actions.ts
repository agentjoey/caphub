import type { Pool, PoolClient } from "pg";
import { capabilityTypeSchema, isValidTag, type CapabilityType } from "../analysis/card";
import { bumpTags } from "../analysis/tags";
import type { Pipeline } from "../config";
import { newId } from "../ids";
import { getDict, type Locale } from "../i18n";
import { stripNul } from "../text/sanitize";
import { isProgress, type Progress } from "./labels";

export type ActionResult =
  | { ok: true; updatedAt: string }
  | { ok: false; reason: "CONFLICT" | "NOT_FOUND" | "INVALID" | "OBJECT_GONE"; message: string };

const conflict = (message: string): ActionResult => ({ ok: false, reason: "CONFLICT", message });
const invalid = (message: string): ActionResult => ({ ok: false, reason: "INVALID", message });
const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isParsableTimestamp = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isUniqueViolation = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";

/** Rolls back on error and never returns a client to the pool in an unknown state (pg advises passing the error to release()). */
async function tx<T>(pool: Pool, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const r = await fn(db);
    await db.query("COMMIT");
    db.release();
    return r;
  } catch (e) {
    try {
      await db.query("ROLLBACK");
      db.release();
    } catch (rollbackError) {
      db.release(rollbackError as Error);
    }
    throw e;
  }
}

async function missingOrConflict(db: Pick<Pool, "query">, id: string, locale: Locale, busyMessage?: string): Promise<ActionResult> {
  const dict = getDict(locale).actions;
  const r = await db.query("SELECT 1 FROM caphub_v2.capabilities WHERE id = $1 AND deleted_at IS NULL", [id]);
  return r.rows.length ? conflict(busyMessage ?? dict.conflict) : { ok: false, reason: "NOT_FOUND", message: dict.cardNotFound };
}

export function decide(pool: Pool, input: { id: string; expectedUpdatedAt: string; verdict: "keep" | "discard" }, locale: Locale = "zh"): Promise<ActionResult> {
  const dict = getDict(locale).actions;
  if (!isNonEmptyString(input.id) || !isParsableTimestamp(input.expectedUpdatedAt) || !["keep", "discard"].includes(input.verdict)) {
    return Promise.resolve(invalid(dict.invalid));
  }
  return tx(pool, async (db) => {
    const r = await db.query<{ updated_at: Date; tags: string[]; previous: string }>(
      `UPDATE caphub_v2.capabilities cb SET verdict = $3, verdict_by = 'human', verdict_at = now(), updated_at = now(),
         serial = CASE WHEN $3 = 'keep' THEN coalesce(serial, nextval('caphub_v2.capability_serial')) ELSE serial END
       FROM (SELECT verdict AS previous FROM caphub_v2.capabilities WHERE id = $1) prev
       WHERE cb.id = $1 AND date_trunc('milliseconds', cb.updated_at) = $2::timestamptz AND cb.deleted_at IS NULL
       RETURNING cb.updated_at, cb.tags, prev.previous`,
      [input.id, input.expectedUpdatedAt, input.verdict]);
    const row = r.rows[0];
    if (!row) return missingOrConflict(db, input.id, locale);
    if (input.verdict === "keep" && row.previous !== "keep") await bumpTags(db, row.tags);
    return { ok: true, updatedAt: iso(row.updated_at) };
  });
}

export function editSuggestion(pool: Pool, input: { id: string; expectedUpdatedAt: string; type: CapabilityType; usage: "integrate" | "reference"; tags: string[] }, locale: Locale = "zh"): Promise<ActionResult> {
  const dict = getDict(locale).actions;
  if (!isNonEmptyString(input.id) || !isParsableTimestamp(input.expectedUpdatedAt)) return Promise.resolve(invalid(dict.invalid));
  if (!Array.isArray(input.tags) || !input.tags.every((t) => typeof t === "string")) return Promise.resolve(invalid(dict.invalid));
  if (!capabilityTypeSchema.safeParse(input.type).success || !["integrate", "reference"].includes(input.usage)) {
    return Promise.resolve(invalid(dict.typeOrUsageInvalid));
  }
  const tags = [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  const bad = tags.filter((t) => !isValidTag(t));
  if (bad.length || tags.length < 1 || tags.length > 6) {
    return Promise.resolve(invalid(bad.length ? `${dict.tagsInvalidPrefix}${bad.join(dict.tagsJoinSeparator)}${dict.tagsInvalidSuffix}` : dict.tagsCountInvalid));
  }
  return tx(pool, async (db) => {
    const r = await db.query<{ updated_at: Date; tags: string[]; previous: string }>(
      `UPDATE caphub_v2.capabilities cb SET type = $3, usage = $4, tags = $5, verdict = 'keep', verdict_by = 'human', verdict_at = now(), updated_at = now(),
         serial = coalesce(serial, nextval('caphub_v2.capability_serial'))
       FROM (SELECT verdict AS previous FROM caphub_v2.capabilities WHERE id = $1) prev
       WHERE cb.id = $1 AND date_trunc('milliseconds', cb.updated_at) = $2::timestamptz AND cb.deleted_at IS NULL
       RETURNING cb.updated_at, cb.tags, prev.previous`,
      [input.id, input.expectedUpdatedAt, input.type, input.usage, tags]);
    const row = r.rows[0];
    if (!row) return missingOrConflict(db, input.id, locale);
    if (row.previous !== "keep") await bumpTags(db, tags);
    return { ok: true, updatedAt: iso(row.updated_at) };
  });
}

export async function softDelete(pool: Pool, input: { id: string; expectedUpdatedAt: string }, locale: Locale = "zh"): Promise<ActionResult> {
  const dict = getDict(locale).actions;
  if (!isNonEmptyString(input.id) || !isParsableTimestamp(input.expectedUpdatedAt)) return invalid(dict.invalid);
  const r = await pool.query<{ updated_at: Date }>(
    `UPDATE caphub_v2.capabilities SET deleted_at = now(), updated_at = now()
     WHERE id = $1 AND date_trunc('milliseconds', updated_at) = $2::timestamptz AND deleted_at IS NULL RETURNING updated_at`,
    [input.id, input.expectedUpdatedAt]);
  return r.rows[0] ? { ok: true, updatedAt: iso(r.rows[0].updated_at) } : missingOrConflict(pool, input.id, locale);
}

/**
 * Normalizes an optional self-build link: blank/absent becomes NULL, http(s) URLs are kept
 * (NUL-stripped, since a pasted value can carry one and Postgres text cannot store U+0000),
 * anything else — including `javascript:` and other schemes — is rejected by returning
 * `undefined`, which the caller turns into an INVALID ActionResult.
 */
function normalizeProgressLink(link: string | null | undefined): string | null | undefined {
  if (link === null || link === undefined) return null;
  if (typeof link !== "string") return undefined;
  const value = stripNul(link).trim();
  if (!value) return null;
  if (value.length > 500) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return value;
}

/**
 * Records self-build progress on a `usage = 'reference'` card. Uses the same
 * `date_trunc('milliseconds', updated_at)` optimistic lock as decide()/editSuggestion() and
 * bumps `updated_at` too — one lock discipline for every writer, at the cost of re-embedding
 * the card on the next embed tick (accepted in the M3.5 plan). Never touches `verdict`.
 */
export async function setProgress(
  pool: Pool,
  input: { id: string; expectedUpdatedAt: string; progress: Progress; link?: string | null },
  locale: Locale = "zh"
): Promise<ActionResult> {
  const dict = getDict(locale).actions;
  if (!isNonEmptyString(input.id) || !isParsableTimestamp(input.expectedUpdatedAt)) return invalid(dict.invalid);
  if (!isProgress(input.progress)) return invalid(dict.progressInvalid);
  const link = normalizeProgressLink(input.link);
  if (link === undefined) return invalid(dict.progressLinkInvalid);
  const r = await pool.query<{ updated_at: Date }>(
    `UPDATE caphub_v2.capabilities SET progress = $3, progress_link = $4, progress_at = now(), updated_at = now()
     WHERE id = $1 AND date_trunc('milliseconds', updated_at) = $2::timestamptz AND deleted_at IS NULL AND usage = 'reference'
     RETURNING updated_at`,
    [input.id, input.expectedUpdatedAt, input.progress, link]);
  if (r.rows[0]) return { ok: true, updatedAt: iso(r.rows[0].updated_at) };
  // The `usage = 'reference'` guard above makes a miss ambiguous, so say which it was instead
  // of reporting a phantom "changed elsewhere" for a card that simply has no progress to track.
  const row = (await pool.query<{ usage: string }>(
    "SELECT usage FROM caphub_v2.capabilities WHERE id = $1 AND deleted_at IS NULL", [input.id])).rows[0];
  if (row && row.usage !== "reference") return invalid(dict.progressNotReference);
  return missingOrConflict(pool, input.id, locale);
}

export async function requestRerun(pool: Pool, input: { captureId: string; pipeline: Pipeline }, locale: Locale = "zh"): Promise<ActionResult> {
  const dict = getDict(locale).actions;
  if (!isNonEmptyString(input.captureId)) return invalid(dict.invalid);
  const c = (await pool.query<{ kind: string; purged: boolean; active: boolean }>(
    `SELECT c.kind,
            EXISTS (SELECT 1 FROM caphub_v2.retention t WHERE t.object_key = c.object_key AND t.purged_at IS NOT NULL) AS purged,
            EXISTS (SELECT 1 FROM caphub_v2.analysis_runs r WHERE r.capture_id = c.id AND r.state IN ('queued','running')) AS active
     FROM caphub_v2.captures c WHERE c.id = $1`, [input.captureId])).rows[0];
  if (!c) return { ok: false, reason: "NOT_FOUND", message: dict.captureNotFound };
  if (c.kind === "image" && c.purged) return { ok: false, reason: "OBJECT_GONE", message: dict.objectExpired };
  if (c.active) return conflict(dict.alreadyQueued);
  try {
    await pool.query("INSERT INTO caphub_v2.analysis_runs (id, capture_id, pipeline, state) VALUES ($1, $2, $3, 'queued')",
      [newId("run"), input.captureId, input.pipeline]);
  } catch (e) {
    // A concurrent request can win the pre-check race above; the partial unique index
    // (capture_id, pipeline) WHERE state IN ('queued','running') is the real guard.
    if (isUniqueViolation(e)) return conflict(dict.alreadyQueued);
    throw e;
  }
  return { ok: true, updatedAt: new Date().toISOString() };
}

export async function requestReview(pool: Pool, input: { id: string }, locale: Locale = "zh"): Promise<ActionResult> {
  const dict = getDict(locale).actions;
  if (!isNonEmptyString(input.id)) return invalid(dict.invalid);
  const r = await pool.query<{ id: string }>(
    `UPDATE caphub_v2.capabilities SET review_requested_at = now(), review_error = NULL
     WHERE id = $1 AND deleted_at IS NULL AND review_requested_at IS NULL RETURNING id`, [input.id]);
  if (r.rows[0]) return { ok: true, updatedAt: new Date().toISOString() };
  return missingOrConflict(pool, input.id, locale, dict.reviewInProgress);
}
