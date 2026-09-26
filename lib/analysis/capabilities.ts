import type { Pool, PoolClient } from "pg";
import { newId } from "../ids";
import { assertRunNotAborted } from "../queue/runs";
import { jsonStringifyStripNul, stripNul } from "../text/sanitize";
import type { Card } from "./card";

export interface UpsertCapabilityResult {
  id: string;
  verdict: string;
  /** The row's verdict before this upsert, or null if this capture had no capability row yet. */
  previousVerdict: string | null;
  /** Whether the row is (or was) soft-deleted. */
  deleted: boolean;
}

export async function upsertCapability(
  db: Pick<Pool | PoolClient, "query">,
  row: {
    captureId: string; runId: string; card: Card; verdict: "keep" | "discard" | "pending"; verdictBy: "auto" | null;
    prompts: string[]; promptUnresolved: number; signal?: AbortSignal;
  }
): Promise<UpsertCapabilityResult> {
  const c = row.card;
  // The INSERT's VALUES list is evaluated even when the row hits ON CONFLICT (Postgres builds
  // the whole proposed row before checking the conflict), so a nextval() there would burn a
  // serial number on every re-run of an already-`keep` card. Pass NULL in VALUES instead — a
  // genuinely brand-new keep row gets its serial assigned by the follow-up UPDATE below — and
  // let the ON CONFLICT branch keep the existing serial via `coalesce(..., serial)` (a no-op
  // coalesce since the VALUES-side serial is always NULL, but keeps the human-verdict-wins
  // shape symmetric with `verdict`/`verdict_by`/`verdict_at`).
  const r = await db.query<{ id: string; verdict: string; previous_verdict: string | null; deleted: boolean }>(
    `WITH prev AS (
       SELECT verdict, deleted_at FROM caphub_v2.capabilities WHERE capture_id = $2
     ), upsert AS (
       INSERT INTO caphub_v2.capabilities
         (id, capture_id, run_id, title, type, summary, summary_points, signals, suggested_verdict, suggested_reason, confidence,
          verdict, verdict_by, verdict_at, usage, playbook, tags, source_url, scenarios, serial, score, score_reason, source_facts, overlap, open_questions,
          prompts, prompt_unresolved)
       VALUES ($1, $2, $3, $4, $5, $6, $23, $7, $8, $9, $10, $11, $12, CASE WHEN $12::text IS NULL THEN NULL ELSE now() END, $13, $14, $15, $16, $17,
         NULL, $18, $19, $20, $21, $22, $24::jsonb, $25)
       ON CONFLICT (capture_id) DO UPDATE SET
         run_id = excluded.run_id, title = excluded.title, summary = excluded.summary,
         summary_points = excluded.summary_points,
         signals = excluded.signals, suggested_verdict = excluded.suggested_verdict, suggested_reason = excluded.suggested_reason,
         confidence = excluded.confidence,
         usage = CASE WHEN caphub_v2.capabilities.suggestion_by = 'human' THEN caphub_v2.capabilities.usage ELSE excluded.usage END,
         playbook = excluded.playbook,
         tags = CASE WHEN caphub_v2.capabilities.suggestion_by = 'human' THEN caphub_v2.capabilities.tags ELSE excluded.tags END,
         source_url = excluded.source_url, scenarios = excluded.scenarios, source_facts = excluded.source_facts,
         open_questions = excluded.open_questions,
         -- overlap is always overwritten by a rerun's fresh judgement, unlike verdict/type/score
         -- above: it isn't a human-editable field (see migration 010), so there is nothing to
         -- preserve.
         overlap = excluded.overlap,
         -- Verbatim prompts are re-taken from the input source on every run (spec 2026-09-22),
         -- never from a model, so a rerun simply replaces them.
         prompts = excluded.prompts, prompt_unresolved = excluded.prompt_unresolved,
         review_note = NULL, review_error = NULL, review_requested_at = NULL,
         notified_at = NULL, updated_at = now(),
         verdict = CASE WHEN caphub_v2.capabilities.verdict_by = 'human' THEN caphub_v2.capabilities.verdict ELSE excluded.verdict END,
         verdict_by = CASE WHEN caphub_v2.capabilities.verdict_by = 'human' THEN 'human' ELSE excluded.verdict_by END,
         -- A human-pinned type (改建议; see lib/library/actions.ts's editSuggestion) must survive
         -- a rerun even if the pipeline's own pinned-type enforcement (pipeline.ts) somehow
         -- didn't force card.type back to it -- this is the backstop, mirroring how verdict
         -- is pinned above.
         type = CASE WHEN caphub_v2.capabilities.suggestion_by = 'human' THEN caphub_v2.capabilities.type
                     WHEN caphub_v2.capabilities.type_by = 'human' THEN caphub_v2.capabilities.type ELSE excluded.type END,
         type_by = CASE WHEN caphub_v2.capabilities.type_by = 'human' THEN 'human' ELSE excluded.type_by END,
         verdict_at = CASE WHEN caphub_v2.capabilities.verdict_by = 'human' THEN caphub_v2.capabilities.verdict_at ELSE excluded.verdict_at END,
         -- A human decision on this capability must not have its score silently wiped or
         -- churned by a later re-run's card, mirroring how verdict itself is pinned above.
         score = CASE WHEN caphub_v2.capabilities.verdict_by = 'human' THEN caphub_v2.capabilities.score ELSE excluded.score END,
         score_reason = CASE WHEN caphub_v2.capabilities.verdict_by = 'human' THEN caphub_v2.capabilities.score_reason ELSE excluded.score_reason END,
         serial = coalesce(caphub_v2.capabilities.serial, excluded.serial)
       WHERE (caphub_v2.capabilities.suggestion_by <> 'human'
              OR (caphub_v2.capabilities.type = excluded.type AND caphub_v2.capabilities.usage = excluded.usage))
         AND (caphub_v2.capabilities.type_by <> 'human' OR caphub_v2.capabilities.type = excluded.type)
       RETURNING id, verdict, deleted_at
     )
     SELECT upsert.id, upsert.verdict, prev.verdict AS previous_verdict, coalesce(prev.deleted_at, upsert.deleted_at) IS NOT NULL AS deleted
     FROM upsert LEFT JOIN prev ON true`,
    [newId("cab"), row.captureId, row.runId, stripNul(c.title), c.type, stripNul(c.summary), jsonStringifyStripNul(c.signals),
      c.suggested_verdict, stripNul(c.suggested_reason), c.confidence, row.verdict, row.verdictBy, c.usage, jsonStringifyStripNul(c.playbook),
      c.tags.map(stripNul), c.source_url === null ? null : stripNul(c.source_url), c.scenarios.map(stripNul),
      c.score, stripNul(c.score_reason), jsonStringifyStripNul(c.source_facts), jsonStringifyStripNul(c.overlap),
      jsonStringifyStripNul(c.open_questions), jsonStringifyStripNul(c.summary_points),
      jsonStringifyStripNul(row.prompts.map((text) => ({ text }))), row.promptUnresolved]);
  const out = r.rows[0];
  if (!out) throw Object.assign(new Error("SUGGESTION_CHANGED"), { code: "SUGGESTION_CHANGED" as const });
  // Brand-new (or previously-non-keep, now-keep, still-serial-less) rows get their serial
  // assigned here, after the upsert, instead of via nextval() in VALUES — the WHERE clause
  // ensures nextval() is only ever evaluated for a row that will actually keep the number
  // (verdict = 'keep' AND serial IS NULL), so a re-run of an existing keep card is a no-op.
  // updated_at is deliberately not touched.
  if (out.verdict === "keep") {
    if (row.signal) assertRunNotAborted(row.signal);
    await db.query(
      `UPDATE caphub_v2.capabilities SET serial = nextval('caphub_v2.capability_serial')
       WHERE id = $1 AND verdict = 'keep' AND serial IS NULL`,
      [out.id]
    );
    if (row.signal) assertRunNotAborted(row.signal);
  }
  return { id: out.id, verdict: out.verdict, previousVerdict: out.previous_verdict, deleted: out.deleted };
}
