import type { Pool } from "pg";
import { newId } from "../ids";
import type { Card } from "./card";

export async function upsertCapability(
  pool: Pick<Pool, "query">,
  row: { captureId: string; runId: string; card: Card; verdict: "keep" | "discard" | "pending"; verdictBy: "auto" | null }
): Promise<{ id: string; verdict: string }> {
  const c = row.card;
  const r = await pool.query<{ id: string; verdict: string }>(
    `INSERT INTO caphub_v2.capabilities
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
     RETURNING id, verdict`,
    [newId("cab"), row.captureId, row.runId, c.title, c.type, c.summary, JSON.stringify(c.signals), c.suggested_verdict, c.suggested_reason,
      c.confidence, row.verdict, row.verdictBy, c.usage, JSON.stringify(c.playbook), c.tags, c.source_url]);
  return r.rows[0];
}
