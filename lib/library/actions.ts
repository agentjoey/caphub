import type { Pool, PoolClient } from "pg";
import { capabilityTypeSchema, isValidTag, type CapabilityType, type Overlap } from "../analysis/card";
import { bumpTags } from "../analysis/tags";
import type { Pipeline } from "../config";
import { newId } from "../ids";
import { enqueueEnrichRun } from "../queue/runs";
import { getDict, type Locale } from "../i18n";
import { stripNul } from "../text/sanitize";
import { isProgress, type Progress } from "./labels";
import { parseSerialQuery } from "./serial";

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
    const r = await db.query<{ updated_at: Date; tags: string[]; previous: string; capture_id: string; enriched_at: string | null; pipeline: Pipeline }>(
      `UPDATE caphub_v2.capabilities cb SET verdict = $3, verdict_by = 'human', verdict_at = now(), updated_at = now(),
         serial = CASE WHEN $3 = 'keep' THEN coalesce(serial, nextval('caphub_v2.capability_serial')) ELSE serial END
       FROM (SELECT verdict AS previous FROM caphub_v2.capabilities WHERE id = $1) prev
       WHERE cb.id = $1 AND date_trunc('milliseconds', cb.updated_at) = $2::timestamptz AND cb.deleted_at IS NULL
       RETURNING cb.updated_at, cb.tags, prev.previous, cb.capture_id, cb.enriched_at,
         (SELECT r.pipeline FROM caphub_v2.analysis_runs r WHERE r.id = cb.run_id) AS pipeline`,
      [input.id, input.expectedUpdatedAt, input.verdict]);
    const row = r.rows[0];
    if (!row) return { result: await missingOrConflict(db, input.id, locale), enrich: null };
    if (input.verdict === "keep" && row.previous !== "keep") await bumpTags(db, row.tags);
    const enrich = input.verdict === "keep" && row.enriched_at === null ? { captureId: row.capture_id, pipeline: row.pipeline } : null;
    return { result: { ok: true, updatedAt: iso(row.updated_at) } as ActionResult, enrich };
  }).then(async ({ result, enrich }) => {
    // Enqueued after the transaction above has committed, via `pool` (a separate connection),
    // not `db` -- swallowing enqueueEnrichRun's own 23505 handling *inside* that transaction
    // would abort it (any error marks a Postgres transaction failed until ROLLBACK, even one
    // caught in application code). A losing race against another enqueue for the same capture
    // is exactly what migration 011's analysis_runs_one_active_enrich exists to stop.
    if (enrich) await enqueueEnrichRun(pool, enrich.captureId, enrich.pipeline);
    return result;
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
    const r = await db.query<{ updated_at: Date; tags: string[]; previous: string; capture_id: string; enriched_at: string | null; pipeline: Pipeline }>(
      `UPDATE caphub_v2.capabilities cb SET type = $3, type_by = 'human', usage = $4, tags = $5, suggestion_by = 'human', verdict = 'keep', verdict_by = 'human', verdict_at = now(), updated_at = now(),
         serial = coalesce(serial, nextval('caphub_v2.capability_serial'))
       FROM (SELECT verdict AS previous FROM caphub_v2.capabilities WHERE id = $1) prev
       WHERE cb.id = $1 AND date_trunc('milliseconds', cb.updated_at) = $2::timestamptz AND cb.deleted_at IS NULL
       RETURNING cb.updated_at, cb.tags, prev.previous, cb.capture_id, cb.enriched_at,
         (SELECT r.pipeline FROM caphub_v2.analysis_runs r WHERE r.id = cb.run_id) AS pipeline`,
      [input.id, input.expectedUpdatedAt, input.type, input.usage, tags]);
    const row = r.rows[0];
    if (!row) return { result: await missingOrConflict(db, input.id, locale), enrich: null };
    if (row.previous !== "keep") await bumpTags(db, tags);
    // editSuggestion always results in verdict = 'keep' (set unconditionally above), so the
    // only gate here is whether this card has ever been enriched.
    const enrich = row.enriched_at === null ? { captureId: row.capture_id, pipeline: row.pipeline } : null;
    return { result: { ok: true, updatedAt: iso(row.updated_at) } as ActionResult, enrich };
  }).then(async ({ result, enrich }) => {
    // See decide()'s matching comment: enqueued after this transaction has committed, via
    // `pool`, not `db`.
    if (enrich) await enqueueEnrichRun(pool, enrich.captureId, enrich.pipeline);
    return result;
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
  // verdict = 'keep' guards against a discarded reference card sitting at a progress other than
  // its initial 'todo' — a discard should retire the card from self-build tracking, but nothing
  // else resets `progress`, so without this a discarded card could otherwise be pushed to
  // 'building' and then never show up (or wrongly keep showing up) in the 待自研 tile / `/todo`.
  const r = await pool.query<{ updated_at: Date }>(
    `UPDATE caphub_v2.capabilities SET progress = $3, progress_link = $4, progress_at = now(), updated_at = now()
     WHERE id = $1 AND date_trunc('milliseconds', updated_at) = $2::timestamptz AND deleted_at IS NULL AND usage = 'reference' AND verdict = 'keep'
     RETURNING updated_at`,
    [input.id, input.expectedUpdatedAt, input.progress, link]);
  if (r.rows[0]) return { ok: true, updatedAt: iso(r.rows[0].updated_at) };
  // The `usage = 'reference' AND verdict = 'keep'` guard above makes a miss ambiguous, so say
  // which it was instead of reporting a phantom "changed elsewhere" for a card that simply has
  // no progress to track.
  const row = (await pool.query<{ usage: string; verdict: string }>(
    "SELECT usage, verdict FROM caphub_v2.capabilities WHERE id = $1 AND deleted_at IS NULL", [input.id])).rows[0];
  if (row && row.usage !== "reference") return invalid(dict.progressNotReference);
  if (row && row.verdict !== "keep") return invalid(dict.progressNotKept);
  return missingOrConflict(pool, input.id, locale);
}

export async function requestRerun(pool: Pool, input: { captureId: string; pipeline: Pipeline }, locale: Locale = "zh"): Promise<ActionResult> {
  const dict = getDict(locale).actions;
  if (!isNonEmptyString(input.captureId)) return invalid(dict.invalid);
  const c = (await pool.query<{ kind: string; purged: boolean; active: boolean }>(
    `SELECT c.kind,
            EXISTS (SELECT 1 FROM caphub_v2.retention t WHERE t.object_key = c.object_key AND t.purged_at IS NOT NULL) AS purged,
            EXISTS (SELECT 1 FROM caphub_v2.analysis_runs r
                    WHERE r.capture_id = c.id AND r.kind = 'analysis' AND r.state IN ('queued','running')) AS active
     FROM caphub_v2.captures c WHERE c.id = $1`, [input.captureId])).rows[0];
  if (!c) return { ok: false, reason: "NOT_FOUND", message: dict.captureNotFound };
  if (c.kind === "image" && c.purged) return { ok: false, reason: "OBJECT_GONE", message: dict.objectExpired };
  if (c.active) return conflict(dict.alreadyQueued);
  try {
    // `kind` is left to its 'analysis' column default (migration 010) — this is the normal
    // pipeline's queue call, and the only other kind is queued by requestDeepAnalysis.
    await pool.query("INSERT INTO caphub_v2.analysis_runs (id, capture_id, pipeline, state) VALUES ($1, $2, $3, 'queued')",
      [newId("run"), input.captureId, input.pipeline]);
  } catch (e) {
    // A concurrent request can win the pre-check race above; the partial unique index
    // analysis_runs_one_active — (capture_id, pipeline) WHERE state IN ('queued','running')
    // AND kind = 'analysis' — is the real guard, and migration 010 scoped it to that kind. The
    // pre-check above must carry the same `kind` predicate or it would be stricter than the
    // database and reject a rerun that the insert would happily have accepted (M3.6 fix round 3).
    if (isUniqueViolation(e)) return conflict(dict.alreadyQueued);
    throw e;
  }
  return { ok: true, updatedAt: new Date().toISOString() };
}

/**
 * Queues a deep-analysis run (`analysis_runs.kind = 'deep'`, see migration 010) for a capture's
 * card. Only a kept, non-deleted card can be deep-analyzed: deep analysis spends ~8 provider
 * calls (see deep.ts's DEEP_BUDGET_LIMITS), which is not worth doing for a card that was
 * discarded or is still awaiting a verdict.
 *
 * `pipeline` is NOT NULL on `analysis_runs` but carries no meaning for a deep run (its providers
 * are fixed — DeepSeek + Tavily, see createDeepAnalysisDeps), so the card's own run's pipeline is
 * reused rather than asking the caller for one it cannot sensibly choose.
 *
 * Concurrency is guarded exactly like {@link requestRerun}: a pre-check for readability, with
 * migration 010's `analysis_runs_one_active_deep` partial unique index (one active deep run per
 * capture) as the real guard — a concurrent request that wins the race surfaces as 23505.
 */
export async function requestDeepAnalysis(pool: Pool, input: { captureId: string }, locale: Locale = "zh"): Promise<ActionResult> {
  const dict = getDict(locale).actions;
  if (!isNonEmptyString(input.captureId)) return invalid(dict.invalid);
  const row = (await pool.query<{ verdict: string; pipeline: string; active: boolean }>(
    `SELECT cb.verdict, r.pipeline,
            EXISTS (SELECT 1 FROM caphub_v2.analysis_runs d
                    WHERE d.capture_id = $1 AND d.kind = 'deep' AND d.state IN ('queued','running')) AS active
     FROM caphub_v2.capabilities cb
     JOIN caphub_v2.analysis_runs r ON r.id = cb.run_id
     WHERE cb.capture_id = $1 AND cb.deleted_at IS NULL`, [input.captureId])).rows[0];
  if (!row) return { ok: false, reason: "NOT_FOUND", message: dict.cardNotFound };
  if (row.verdict !== "keep") return invalid(dict.deepNotKept);
  if (row.active) return conflict(dict.deepAlreadyQueued);
  try {
    await pool.query("INSERT INTO caphub_v2.analysis_runs (id, capture_id, pipeline, state, kind) VALUES ($1, $2, $3, 'queued', 'deep')",
      [newId("run"), input.captureId, row.pipeline]);
  } catch (e) {
    if (isUniqueViolation(e)) return conflict(dict.deepAlreadyQueued);
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

export type CapabilityStatus = "active" | "deprecated" | "superseded";
const STATUS_VALUES: readonly CapabilityStatus[] = ["active", "deprecated", "superseded"];
function isCapabilityStatus(v: unknown): v is CapabilityStatus {
  return typeof v === "string" && (STATUS_VALUES as readonly string[]).includes(v);
}

const STATUS_NOTE_MAX = 500;

/** Blank/absent becomes NULL; anything else is NUL-stripped, trimmed and length-capped, mirroring normalizeProgressLink's leniency. */
function normalizeStatusNote(note: string | null | undefined): string | null | undefined {
  if (note === null || note === undefined) return null;
  if (typeof note !== "string") return undefined;
  const value = stripNul(note).trim();
  if (!value) return null;
  if (value.length > STATUS_NOTE_MAX) return undefined;
  return value;
}

/**
 * Sets a capability's lifecycle status. `supersededBy` is the UI's serial-code input (e.g.
 * "TOL-0009"), resolved here to the actual capability id via {@link parseSerialQuery} — the
 * `superseded_by` column is an id FK, never a serial. Allowed only alongside
 * `status = 'superseded'`, and only when it resolves to an existing, non-deleted, different
 * card; every other combination (missing when required, present when not, unresolvable,
 * self-reference) is INVALID. Uses the same optimistic lock discipline as decide()/
 * editSuggestion()/setProgress().
 */
export function setStatus(
  pool: Pool,
  input: { id: string; expectedUpdatedAt: string; status: CapabilityStatus; supersededBy?: string | null; note?: string | null },
  locale: Locale = "zh"
): Promise<ActionResult> {
  const dict = getDict(locale).actions;
  if (!isNonEmptyString(input.id) || !isParsableTimestamp(input.expectedUpdatedAt) || !isCapabilityStatus(input.status)) {
    return Promise.resolve(invalid(dict.invalid));
  }
  const note = normalizeStatusNote(input.note);
  if (note === undefined) return Promise.resolve(invalid(dict.statusNoteInvalid));

  const supersededByRaw = input.supersededBy ?? null;
  if (input.status === "superseded") {
    if (!isNonEmptyString(supersededByRaw)) return Promise.resolve(invalid(dict.statusSupersededByRequired));
  } else if (supersededByRaw !== null) {
    return Promise.resolve(invalid(dict.statusSupersededByNotAllowed));
  }

  return tx(pool, async (db) => {
    let supersededById: string | null = null;
    if (input.status === "superseded") {
      const serial = parseSerialQuery(supersededByRaw!);
      const target = serial !== null
        ? (await db.query<{ id: string }>(
            "SELECT id FROM caphub_v2.capabilities WHERE serial = $1 AND deleted_at IS NULL", [serial])).rows[0]
        : undefined;
      if (!target) return invalid(dict.statusSupersededByNotFound);
      if (target.id === input.id) return invalid(dict.statusSupersededBySelf);
      supersededById = target.id;
    }

    const r = await db.query<{ updated_at: Date }>(
      `UPDATE caphub_v2.capabilities SET status = $3, superseded_by = $4, status_at = now(), status_note = $5, updated_at = now()
       WHERE id = $1 AND date_trunc('milliseconds', updated_at) = $2::timestamptz AND deleted_at IS NULL
       RETURNING updated_at`,
      [input.id, input.expectedUpdatedAt, input.status, supersededById, note]);
    const row = r.rows[0];
    if (!row) return missingOrConflict(db, input.id, locale);
    return { ok: true, updatedAt: iso(row.updated_at) };
  });
}

/**
 * Dismisses this card's own library-overlap finding: sets `overlap` back to the "no overlap"
 * shape without touching the other card. Uses this card's own optimistic lock, like any other
 * writer of this row.
 */
export async function ignoreOverlap(pool: Pool, input: { id: string; expectedUpdatedAt: string }, locale: Locale = "zh"): Promise<ActionResult> {
  const dict = getDict(locale).actions;
  if (!isNonEmptyString(input.id) || !isParsableTimestamp(input.expectedUpdatedAt)) return invalid(dict.invalid);
  const r = await pool.query<{ updated_at: Date }>(
    `UPDATE caphub_v2.capabilities SET overlap = '{"relation":"none","target":null,"reason":""}'::jsonb, updated_at = now()
     WHERE id = $1 AND date_trunc('milliseconds', updated_at) = $2::timestamptz AND deleted_at IS NULL
     RETURNING updated_at`,
    [input.id, input.expectedUpdatedAt]);
  return r.rows[0] ? { ok: true, updatedAt: iso(r.rows[0].updated_at) } : missingOrConflict(pool, input.id, locale);
}

/**
 * Accepts this card's own library-overlap finding by marking the OTHER card (`overlap.target`,
 * a serial code) as superseded by this one. Writes only the other card's row — this card's
 * `overlap`/`updated_at` are left untouched, so the caller must not adopt this action's
 * `updatedAt` as its own lock token (same discipline as requestReview()/requestRerun()). The
 * target row is read fresh and locked (`FOR UPDATE`) inside the transaction rather than trusting
 * a client-supplied lock token, since the UI showing this notice never displays the other card.
 */
export function supersedeOverlapTarget(pool: Pool, input: { id: string }, locale: Locale = "zh"): Promise<ActionResult> {
  const dict = getDict(locale).actions;
  if (!isNonEmptyString(input.id)) return Promise.resolve(invalid(dict.invalid));
  return tx(pool, async (db) => {
    const source = (await db.query<{ overlap: Overlap }>(
      "SELECT overlap FROM caphub_v2.capabilities WHERE id = $1 AND deleted_at IS NULL", [input.id])).rows[0];
    if (!source) return { ok: false, reason: "NOT_FOUND", message: dict.cardNotFound };
    const overlap = source.overlap;
    if (!overlap || overlap.relation === "none" || !overlap.target) return invalid(dict.overlapNoTarget);
    const serial = parseSerialQuery(overlap.target);
    if (serial === null) return invalid(dict.overlapTargetInvalid);
    const target = (await db.query<{ id: string; status: CapabilityStatus }>(
      "SELECT id, status FROM caphub_v2.capabilities WHERE serial = $1 AND deleted_at IS NULL FOR UPDATE", [serial])).rows[0];
    if (!target) return invalid(dict.statusSupersededByNotFound);
    if (target.id === input.id) return invalid(dict.statusSupersededBySelf);
    // Don't silently overwrite a target that was already retired by someone/something else in
    // the meantime (e.g. a reviewer resolved the other card's own notice first) -- surface it
    // as a conflict instead of clobbering whatever status/note/superseded_by it already carries.
    if (target.status === "deprecated" || target.status === "superseded") {
      return conflict(dict.overlapTargetAlreadyRetired);
    }
    const r = await db.query<{ updated_at: Date }>(
      `UPDATE caphub_v2.capabilities SET status = 'superseded', superseded_by = $2, status_at = now(), status_note = $3, updated_at = now()
       WHERE id = $1 RETURNING updated_at`,
      [target.id, input.id, overlap.reason || null]);
    const row = r.rows[0];
    // The FOR UPDATE lock above should make this unreachable in practice (nothing else can
    // delete/rewrite the target row concurrently), but guard it anyway rather than dereference
    // an absent row -- and, crucially, skip clearing this card's own overlap below when it does
    // happen, so a failed write to the other card can never leave this one silently un-nagging.
    if (!row) return missingOrConflict(db, target.id, locale);
    // Same transaction as the write above (ruling, fix round 1): resolving this card's own
    // overlap notice is the human's confirmation that they acted on it, so it must land
    // atomically with the other card actually being marked superseded -- never one without the
    // other. Only `relation` is cleared; `target`/`reason` are left as an audit trail of what was
    // resolved, which costs nothing extra here (jsonb_set touches one key).
    await db.query(
      `UPDATE caphub_v2.capabilities SET overlap = jsonb_set(overlap, '{relation}', '"none"') WHERE id = $1`,
      [input.id]);
    return { ok: true, updatedAt: iso(row.updated_at) };
  });
}
