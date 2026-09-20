import type { Pool } from "pg";
import type { Pipeline } from "../config";
import { newId } from "../ids";

export interface Lease { runId: string; captureId: string; pipeline: Pipeline; ownerToken: string }
export interface RunOutcome { state: "done" | "failed"; errorCode?: string; errorMessage?: string }

/**
 * A normal analysis run, a deep-analysis run and an enrichment run (migration 010/011's
 * `analysis_runs.kind`) share this same lease/heartbeat/finish machinery, but each kind's steps
 * run for a different amount of time, so each gets its own lease -- see {@link LEASE_SECONDS}.
 * `claim`/`heartbeat` take `kind` to scope themselves to one kind's rows at a time; `finish`
 * doesn't need it since run ids are globally unique.
 */
export type RunKind = "analysis" | "deep" | "enrich";
const LEASE_SECONDS: Record<RunKind, number> = { analysis: 120, deep: 360, enrich: 240 };
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

/** True for a Postgres unique_violation (23505) error, e.g. a race against a partial unique index. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";
}

/**
 * Queues an `enrich` run (M3.7's second pass) for a capture whose card just became `keep` and
 * has never been enriched (`enriched_at IS NULL` -- the caller's job to check before calling
 * this). Three call sites: upsertCapability (auto-keep), decide(keep) and editSuggestion (which
 * always results in keep) -- see lib/analysis/pipeline.ts and lib/library/actions.ts.
 *
 * `pipeline` is NOT NULL on `analysis_runs` but carries no meaning for an enrich run (its
 * providers are fixed -- DeepSeek + Tavily, see createEnrichDeps), same note as
 * requestDeepAnalysis's on 'deep' runs; callers pass along whatever pipeline is already in
 * scope (the triggering run's own, or the card's) rather than asking for one they can't
 * sensibly choose.
 *
 * Returns whether it actually inserted a row (`true`) or swallowed a losing race (`false`) --
 * scripts/backfill-enrichment.ts's `--apply` reads this to report a queued/already-queued split
 * that reflects reality; every other call site (upsertCapability, decide(keep), editSuggestion)
 * ignores it, since none of them have anything useful to do with either outcome.
 *
 * Concurrency is a fire-and-forget INSERT, not a pre-check + insert: migration 011's
 * `analysis_runs_one_active_enrich` partial unique index (one active enrich run per capture) is
 * the only guard, and a losing race surfaces as 23505 here, swallowed as "already queued" rather
 * than treated as a failure of whatever write just triggered this (a card decision or upsert
 * must never fail because an enrich run was already queued for it).
 */
export async function enqueueEnrichRun(pool: Pick<Pool, "query">, captureId: string, pipeline: Pipeline): Promise<boolean> {
  try {
    await pool.query(
      "INSERT INTO caphub_v2.analysis_runs (id, capture_id, pipeline, state, kind) VALUES ($1, $2, $3, 'queued', 'enrich')",
      [newId("run"), captureId, pipeline]
    );
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}
