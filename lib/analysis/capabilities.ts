import type { Pool, PoolClient } from "pg";
import { newId } from "../ids";
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
  row: { captureId: string; runId: string; card: Card; verdict: "keep" | "discard" | "pending"; verdictBy: "auto" | null }
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
         (id, capture_id, run_id, title, type, summary, signals, suggested_verdict, suggested_reason, confidence,
          verdict, verdict_by, verdict_at, usage, playbook, tags, source_url, scenarios, serial)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $12::text IS NULL THEN NULL ELSE now() END, $13, $14, $15, $16, $17,
         NULL)
       ON CONFLICT (capture_id) DO UPDATE SET
         run_id = excluded.run_id, title = excluded.title, type = excluded.type, summary = excluded.summary,
         signals = excluded.signals, suggested_verdict = excluded.suggested_verdict, suggested_reason = excluded.suggested_reason,
         confidence = excluded.confidence, usage = excluded.usage, playbook = excluded.playbook, tags = excluded.tags,
         source_url = excluded.source_url, scenarios = excluded.scenarios, review_note = NULL, review_error = NULL, review_requested_at = NULL,
         notified_at = NULL, updated_at = now(),
         verdict = CASE WHEN caphub_v2.capabilities.verdict_by = 'human' THEN caphub_v2.capabilities.verdict ELSE excluded.verdict END,
         verdict_by = CASE WHEN caphub_v2.capabilities.verdict_by = 'human' THEN 'human' ELSE excluded.verdict_by END,
         verdict_at = CASE WHEN caphub_v2.capabilities.verdict_by = 'human' THEN caphub_v2.capabilities.verdict_at ELSE excluded.verdict_at END,
         serial = coalesce(caphub_v2.capabilities.serial, excluded.serial)
       RETURNING id, verdict, deleted_at
     )
     SELECT upsert.id, upsert.verdict, prev.verdict AS previous_verdict, coalesce(prev.deleted_at, upsert.deleted_at) IS NOT NULL AS deleted
     FROM upsert LEFT JOIN prev ON true`,
    [newId("cab"), row.captureId, row.runId, stripNul(c.title), c.type, stripNul(c.summary), jsonStringifyStripNul(c.signals),
      c.suggested_verdict, stripNul(c.suggested_reason), c.confidence, row.verdict, row.verdictBy, c.usage, jsonStringifyStripNul(c.playbook),
      c.tags.map(stripNul), c.source_url === null ? null : stripNul(c.source_url), c.scenarios.map(stripNul)]);
  const out = r.rows[0];
  // Brand-new (or previously-non-keep, now-keep, still-serial-less) rows get their serial
  // assigned here, after the upsert, instead of via nextval() in VALUES — the WHERE clause
  // ensures nextval() is only ever evaluated for a row that will actually keep the number
  // (verdict = 'keep' AND serial IS NULL), so a re-run of an existing keep card is a no-op.
  // updated_at is deliberately not touched.
  if (out.verdict === "keep") {
    await db.query(
      `UPDATE caphub_v2.capabilities SET serial = nextval('caphub_v2.capability_serial')
       WHERE id = $1 AND verdict = 'keep' AND serial IS NULL`,
      [out.id]
    );
  }
  return { id: out.id, verdict: out.verdict, previousVerdict: out.previous_verdict, deleted: out.deleted };
}
