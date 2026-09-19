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
  const r = await db.query<{ id: string; verdict: string; previous_verdict: string | null; deleted: boolean }>(
    `WITH prev AS (
       SELECT verdict, deleted_at FROM caphub_v2.capabilities WHERE capture_id = $2
     ), upsert AS (
       INSERT INTO caphub_v2.capabilities
         (id, capture_id, run_id, title, type, summary, signals, suggested_verdict, suggested_reason, confidence,
          verdict, verdict_by, verdict_at, usage, playbook, tags, source_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $12::text IS NULL THEN NULL ELSE now() END, $13, $14, $15, $16)
       ON CONFLICT (capture_id) DO UPDATE SET
         run_id = excluded.run_id, title = excluded.title, type = excluded.type, summary = excluded.summary,
         signals = excluded.signals, suggested_verdict = excluded.suggested_verdict, suggested_reason = excluded.suggested_reason,
         confidence = excluded.confidence, usage = excluded.usage, playbook = excluded.playbook, tags = excluded.tags,
         source_url = excluded.source_url, review_note = NULL, notified_at = NULL, updated_at = now(),
         verdict = CASE WHEN caphub_v2.capabilities.verdict_by = 'human' THEN caphub_v2.capabilities.verdict ELSE excluded.verdict END,
         verdict_by = CASE WHEN caphub_v2.capabilities.verdict_by = 'human' THEN 'human' ELSE excluded.verdict_by END,
         verdict_at = CASE WHEN caphub_v2.capabilities.verdict_by = 'human' THEN caphub_v2.capabilities.verdict_at ELSE excluded.verdict_at END
       RETURNING id, verdict, deleted_at
     )
     SELECT upsert.id, upsert.verdict, prev.verdict AS previous_verdict, coalesce(prev.deleted_at, upsert.deleted_at) IS NOT NULL AS deleted
     FROM upsert LEFT JOIN prev ON true`,
    [newId("cab"), row.captureId, row.runId, stripNul(c.title), c.type, stripNul(c.summary), jsonStringifyStripNul(c.signals),
      c.suggested_verdict, stripNul(c.suggested_reason), c.confidence, row.verdict, row.verdictBy, c.usage, jsonStringifyStripNul(c.playbook),
      c.tags.map(stripNul), c.source_url === null ? null : stripNul(c.source_url)]);
  const out = r.rows[0];
  return { id: out.id, verdict: out.verdict, previousVerdict: out.previous_verdict, deleted: out.deleted };
}
