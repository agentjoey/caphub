import type { Pool } from "pg";
import type { ObjectStore } from "../storage/s3";

export interface SweepOutcome { objectKey: string; state: "eligible" | "purged" | "failed" }

/**
 * Purges objects whose retention window has elapsed (eligible_at <= now),
 * regardless of any capability verdict on their captures. A per-object
 * advisory lock serializes concurrent sweeps against the same key.
 */
export async function sweepRetention(
  deps: { pool: Pool; objects: Pick<ObjectStore, "deleteExact"> },
  opts: { now: Date; dryRun: boolean; limit?: number }
): Promise<SweepOutcome[]> {
  const limit = opts.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error("limit must be an integer between 1 and 25");
  const now = opts.now.toISOString();
  const due = await deps.pool.query<{ object_key: string }>(
    "SELECT object_key FROM caphub_v2.retention WHERE purged_at IS NULL AND eligible_at <= $1 ORDER BY object_key LIMIT $2", [now, limit]);
  const out: SweepOutcome[] = [];
  for (const { object_key } of due.rows) {
    const db = await deps.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtext('caphub_v2.object'), hashtext($1))", [object_key]);
      const stillEligible = await db.query(
        "SELECT 1 FROM caphub_v2.retention WHERE object_key = $1 AND purged_at IS NULL AND eligible_at <= $2", [object_key, now]);
      if (stillEligible.rows.length === 0) { await db.query("COMMIT"); continue; }
      if (opts.dryRun) { await db.query("COMMIT"); out.push({ objectKey: object_key, state: "eligible" }); continue; }
      try {
        await deps.objects.deleteExact(object_key);
      } catch {
        await db.query("UPDATE caphub_v2.retention SET error_code = 'OBJECT_DELETE_FAILED' WHERE object_key = $1 AND purged_at IS NULL", [object_key]);
        await db.query("COMMIT");
        out.push({ objectKey: object_key, state: "failed" });
        continue;
      }
      await db.query("UPDATE caphub_v2.retention SET purged_at = $2, error_code = NULL WHERE object_key = $1", [object_key, now]);
      await db.query("COMMIT");
      out.push({ objectKey: object_key, state: "purged" });
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  return out;
}
