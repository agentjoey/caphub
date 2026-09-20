import type { Pool } from "pg";
import type { Pipeline } from "../config";

export interface Lease { runId: string; captureId: string; pipeline: Pipeline; ownerToken: string }
export interface RunOutcome { state: "done" | "failed"; errorCode?: string; errorMessage?: string }

/**
 * A normal analysis run and a deep-analysis run (migration 010's `analysis_runs.kind`) share
 * this same lease/heartbeat/finish machinery, but a deep run's steps (plan → up to 6 searches
 * → two synthesize passes) run far longer than a normal run's, so it gets a longer lease --
 * see {@link LEASE_SECONDS}. `claim`/`heartbeat` take `kind` to scope themselves to one kind's
 * rows at a time; `finish` doesn't need it since run ids are globally unique.
 */
export type RunKind = "analysis" | "deep";
const LEASE_SECONDS: Record<RunKind, number> = { analysis: 120, deep: 360 };
/** A run whose lease expired this many times (worker crash mid-run) is failed instead of reclaimed. */
export const MAX_ATTEMPTS = 2;

export class RunQueue {
  constructor(private readonly pool: Pool) {}

  async claim(ownerToken: string, now: Date, kind: RunKind = "analysis"): Promise<Lease | null> {
    const leaseSeconds = String(LEASE_SECONDS[kind]);
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtext('caphub_v2.worker.' || $1), 0)", [kind]);
      await db.query(
        `UPDATE caphub_v2.analysis_runs SET state = 'failed', owner_token = NULL, lease_until = NULL,
           error_code = 'LEASE_EXPIRED', error_message = 'lease expired after ' || attempts || ' attempts', finished_at = $1
         WHERE state = 'running' AND kind = $3 AND lease_until <= $1 AND attempts >= $2`,
        [now.toISOString(), MAX_ATTEMPTS, kind]
      );
      const row = await db.query<{ id: string; capture_id: string; pipeline: Pipeline }>(
        `WITH next AS (
           SELECT id FROM caphub_v2.analysis_runs
           WHERE kind = $4 AND (state = 'queued' OR (state = 'running' AND lease_until <= $1 AND attempts < $3))
             AND NOT EXISTS (SELECT 1 FROM caphub_v2.analysis_runs WHERE state = 'running' AND lease_until > $1 AND kind = $4)
           ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE caphub_v2.analysis_runs r SET state = 'running', owner_token = $2,
           lease_until = $1::timestamptz + ($5 || ' seconds')::interval, attempts = r.attempts + 1,
           started_at = coalesce(r.started_at, $1)
         FROM next WHERE r.id = next.id RETURNING r.id, r.capture_id, r.pipeline`,
        [now.toISOString(), ownerToken, MAX_ATTEMPTS, kind, leaseSeconds]
      );
      await db.query("COMMIT");
      const r = row.rows[0];
      return r ? { runId: r.id, captureId: r.capture_id, pipeline: r.pipeline, ownerToken } : null;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }

  async heartbeat(lease: Lease, now: Date, kind: RunKind = "analysis"): Promise<boolean> {
    const leaseSeconds = String(LEASE_SECONDS[kind]);
    const r = await this.pool.query(
      `UPDATE caphub_v2.analysis_runs SET lease_until = $2::timestamptz + ($4 || ' seconds')::interval
       WHERE id = $1 AND owner_token = $3 AND state = 'running' AND lease_until > $2`,
      [lease.runId, now.toISOString(), lease.ownerToken, leaseSeconds]);
    return r.rowCount === 1;
  }

  async finish(lease: Lease, outcome: RunOutcome, now: Date): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE caphub_v2.analysis_runs SET state = $4, owner_token = NULL, lease_until = NULL,
         error_code = $5, error_message = $6, finished_at = $2
       WHERE id = $1 AND owner_token = $3 AND state = 'running' AND lease_until > $2`,
      [lease.runId, now.toISOString(), lease.ownerToken, outcome.state, outcome.errorCode ?? null, outcome.errorMessage ?? null]);
    return r.rowCount === 1;
  }

  async summary(): Promise<Array<{ state: string; count: number }>> {
    const r = await this.pool.query<{ state: string; count: string }>("SELECT state, count(*)::text AS count FROM caphub_v2.analysis_runs GROUP BY state ORDER BY state");
    return r.rows.map((x) => ({ state: x.state, count: Number(x.count) }));
  }
}
