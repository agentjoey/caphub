/**
 * One-off queue-up pass for M3.7's second pass ("补充调研"): finds every already-kept, active,
 * never-enriched card in the existing library and enqueues an `enrich` run for each one (Task 5,
 * .superpowers/sdd/2026-09-20-caphub-v2-m3_7-enrichment/task-5-brief.md).
 *
 * This script only *enqueues* -- it never calls the model or runs the pass itself. The worker
 * (lib/analysis/enrich.ts's runEnrichment, drained via RunQueue.claim(kind: "enrich")) drains the
 * queue at its own pace, one active run per capture (migration 011's
 * analysis_runs_one_active_enrich partial unique index). Enqueuing serially here rather than
 * running the pass inline avoids saturating DeepSeek/Tavily with a burst of ~150 cards' worth of
 * calls at once, and keeps the lease/budget/retry logic in exactly one place (the worker), not
 * duplicated here.
 *
 * Candidates: `verdict = 'keep' AND status = 'active' AND deleted_at IS NULL AND enriched_at IS
 * NULL`, oldest first (`created_at`) -- same "already-kept, active, untouched-by-this-pass" shape
 * as the brief specifies. An optional `--limit=N` caps how many are loaded, so the controller can
 * queue a small first batch (per the brief: 2-3 cards, including TOL-0045, verified by a human)
 * before queuing the full backlog.
 *
 * Reuses `enqueueEnrichRun` (lib/queue/runs.ts) rather than writing a raw INSERT -- it already
 * knows the one-active-per-capture constraint and the `analysis_runs` row shape. That helper
 * itself swallows a 23505 (unique_violation -- a run is already queued/running for this capture)
 * as a no-op; this script wraps its own call in a try/catch anyway (checking the error's `code`
 * the same way runs.ts's own `isUniqueViolation` does) so that if a race is ever surfaced as an
 * error here -- or a fake enqueue function is substituted in a test -- a 23505 is counted as
 * "already-queued" rather than folded into "failed": neither is this script's problem to fix, but
 * only the second is a sign something is actually wrong.
 *
 * Dry-run by default: prints every candidate card (serial code + title, in candidate order) plus
 * the total and an estimated model-call count (~4 calls per card -- 1 canonical fetch is not a
 * model call, up to 2 Tavily searches + 1 DeepSeek rewrite, see enrich.ts's ENRICH_BUDGET_LIMITS
 * comment for the same accounting), but enqueues nothing. `--apply` enqueues each candidate,
 * counting queued / already-queued (23505) / failed; a failing row is logged and does not abort
 * the rest of the batch. Modeled on scripts/reclassify-types.ts and scripts/find-duplicates.ts:
 * import.meta.url gate so tests can import this module without running `main()`, per-row
 * try/catch, non-zero exit when every attempted row failed.
 */
import type { Pool } from "pg";
import type { CapabilityType } from "../lib/analysis/card";
import type { Pipeline } from "../lib/config";
import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { formatSerial } from "../lib/library/serial";
import { enqueueEnrichRun } from "../lib/queue/runs";

/** ~1 canonical fetch (not model-metered) + up to 2 Tavily searches + 1 DeepSeek rewrite per card (enrich.ts). */
export const ESTIMATED_CALLS_PER_CARD = 4;

function parseArgs(args: string[]): { apply: boolean; limit: number | undefined } {
  const apply = args.includes("--apply");
  const limitArg = args.find((a) => a.startsWith("--limit="));
  if (!limitArg) return { apply, limit: undefined };
  const limit = Number.parseInt(limitArg.slice("--limit=".length), 10);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`--limit must be a positive integer, got: ${limitArg}`);
  }
  return { apply, limit };
}

export interface CandidateRow {
  captureId: string;
  serial: number | null;
  type: CapabilityType;
  title: string;
  pipeline: Pipeline;
}

/**
 * Candidate cards for the backfill: already kept, active, not soft-deleted, never enriched.
 * `pipeline` comes from the triggering `analysis_runs` row (capabilities has no `pipeline`
 * column of its own) -- same join actions.ts's decide()/editSuggestion() use to find what to
 * pass `enqueueEnrichRun`, since an enrich run's providers are fixed but the column is NOT NULL.
 */
export async function loadCandidates(pool: Pick<Pool, "query">, limit?: number): Promise<CandidateRow[]> {
  const sql =
    `SELECT cb.capture_id AS "captureId", cb.serial, cb.type, cb.title,
            (SELECT r.pipeline FROM caphub_v2.analysis_runs r WHERE r.id = cb.run_id) AS pipeline
     FROM caphub_v2.capabilities cb
     WHERE cb.verdict = 'keep' AND cb.status = 'active' AND cb.deleted_at IS NULL AND cb.enriched_at IS NULL
     ORDER BY cb.created_at` + (limit !== undefined ? " LIMIT $1" : "");
  const { rows } = await pool.query<CandidateRow>(sql, limit !== undefined ? [limit] : []);
  return rows;
}

/** True for a Postgres unique_violation (23505) -- same check as lib/queue/runs.ts's own (private) isUniqueViolation. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";
}

export type EnqueueFn = (pool: Pick<Pool, "query">, captureId: string, pipeline: Pipeline) => Promise<void>;

export interface BackfillResult {
  candidates: CandidateRow[];
  queued: number;
  alreadyQueued: number;
  failed: number;
  estimatedCalls: number;
}

/**
 * The backfill loop, factored out of `main()` so it can run against a fake pool and a fake
 * `enqueue` function instead of a real database -- same shape as reclassify-types.ts's
 * runReclassify / find-duplicates.ts's runDuplicateScan. In dry-run (apply=false), candidates are
 * loaded and reported but `enqueue` is never called.
 */
export async function runBackfill(
  pool: Pick<Pool, "query">, enqueue: EnqueueFn, apply: boolean, limit: number | undefined,
  log: (o: Record<string, unknown>) => void
): Promise<BackfillResult> {
  const candidates = await loadCandidates(pool, limit);
  const estimatedCalls = candidates.length * ESTIMATED_CALLS_PER_CARD;
  log({ mode: apply ? "apply" : "dry-run", candidates: candidates.length, estimatedCalls });
  let queued = 0;
  let alreadyQueued = 0;
  let failed = 0;
  if (apply) {
    for (const row of candidates) {
      const label = formatSerial(row.type, row.serial) ?? row.title;
      try {
        await enqueue(pool, row.captureId, row.pipeline);
        queued += 1;
        log({ captureId: row.captureId, label, queued: true });
      } catch (error) {
        if (isUniqueViolation(error)) {
          alreadyQueued += 1;
          log({ captureId: row.captureId, label, alreadyQueued: true });
          continue;
        }
        failed += 1;
        log({ captureId: row.captureId, label, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  log({ candidates: candidates.length, queued, alreadyQueued, failed, mode: apply ? "apply" : "dry-run" });
  return { candidates, queued, alreadyQueued, failed, estimatedCalls };
}

function printCandidates(candidates: CandidateRow[]) {
  if (candidates.length === 0) {
    process.stdout.write("0 candidate(s) to enqueue.\n");
    return;
  }
  for (const row of candidates) {
    const label = formatSerial(row.type, row.serial) ?? row.title;
    process.stdout.write(`  ${label}  ${row.title}\n`);
  }
}

async function main() {
  const { apply, limit } = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env, "script");
  const pool = createPool(config.databaseUrl);
  const log = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`);
  try {
    const { candidates, queued, alreadyQueued, failed, estimatedCalls } = await runBackfill(pool, enqueueEnrichRun, apply, limit, log);
    printCandidates(candidates);
    process.stdout.write(`${candidates.length} candidate(s), ~${estimatedCalls} estimated call(s).\n`);
    if (apply) {
      process.stdout.write(`${queued} queued, ${alreadyQueued} already queued, ${failed} failed.\n`);
    }
    // Every attempted row failing (and none succeeding, queued or already-queued) is the
    // signature of a systemic problem (pool exhaustion, a schema mismatch), not per-row noise --
    // exit non-zero so a caller watching `$?` notices, same discipline as reclassify-types.ts /
    // find-duplicates.ts.
    const attempted = queued + alreadyQueued + failed;
    if (attempted > 0 && queued === 0 && alreadyQueued === 0 && failed === attempted) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

// Only run when invoked as a CLI script (`npx tsx scripts/backfill-enrichment.ts`), not when
// imported (e.g. by scripts/backfill-enrichment.test.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`backfill-enrichment failed: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
