import type { Pool } from "pg";
import { finalizeSourceFacts, scoreResultSchema, type SourceFacts } from "../lib/analysis/card";
import { TIMEOUTS } from "../lib/analysis/pipeline";
import { backfillScorePrompt } from "../lib/analysis/prompts";
import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { createDeepSeekCall } from "../lib/providers/deepseek";
import { jsonStringifyStripNul, stripNul } from "../lib/text/sanitize";

function parseArgs(args: string[]): { apply: boolean } {
  return { apply: args.includes("--apply") };
}

/**
 * Writes the backfilled score for one card. Only `score`, `score_reason` and `source_facts`
 * are touched: this is a one-off scoring pass over already-built cards, not a re-analysis, so
 * `updated_at` (and everything else the card contains) must not move.
 *
 * `score_reason`/`source_facts` come straight from a model response, which — like every other
 * provider-text write path in this repo (see `upsertCapability` in lib/analysis/capabilities.ts)
 * — is sanitized with `stripNul`/`jsonStringifyStripNul` before it reaches a SQL parameter.
 * Postgres rejects U+0000 in text/jsonb columns outright (22P05); without this, a NUL from the
 * model would make the UPDATE throw, the row would be logged as failed with `score` still NULL,
 * and every future run would re-score (and re-fail) it forever. `source_facts` is bound as the
 * stripped JSON *text*, not the object, so jsonb doesn't need to re-parse an already-safe value.
 *
 * `AND score IS NULL` guards against a concurrent re-analysis (e.g. a rerun triggered from the
 * web UI or Telegram) that scored this same card in between the SELECT and this UPDATE: without
 * it, this backfill would silently clobber that fresh score with its own stale one.
 */
export function applyScoreBackfill(
  pool: Pick<Pool, "query">, id: string, score: number, scoreReason: string, sourceFacts: SourceFacts
) {
  return pool.query(
    "UPDATE caphub_v2.capabilities SET score = $2, score_reason = $3, source_facts = $4 WHERE id = $1 AND score IS NULL",
    [id, score, stripNul(scoreReason), jsonStringifyStripNul(sourceFacts)]
  );
}

export interface BackfillScoreCall {
  invoke(input: { prompt: string; schemaName: string; schema: typeof scoreResultSchema }, signal: AbortSignal): Promise<{ value: unknown }>;
}

/**
 * The scoring loop itself, factored out of `main()` so it can run against fakes (a fake pool and
 * a fake DeepSeek call) instead of a real database/provider — same shape as the rest of this
 * repo's tests (see decide.test.ts's fakePool/fakeApi). Returns the done/failed counts so the
 * caller decides the process exit code.
 */
export async function runBackfill(
  pool: Pick<Pool, "query">, call: BackfillScoreCall, apply: boolean, log: (o: Record<string, unknown>) => void
): Promise<{ candidates: number; done: number; failed: number }> {
  // score is nullable with no DB default (migration 007), so an unscored card has NULL;
  // a card a prior backfill run already scored is skipped.
  const { rows } = await pool.query<{
    id: string; title: string; summary: string; signals: string[]; playbook: unknown; tags: string[]; source_url: string | null;
  }>(
    `SELECT id, title, summary, signals, playbook, tags, source_url FROM caphub_v2.capabilities
     WHERE deleted_at IS NULL AND score IS NULL
     ORDER BY created_at`
  );
  log({ mode: apply ? "apply" : "dry-run", candidates: rows.length });
  let done = 0;
  let failed = 0;
  for (const row of rows) {
    const prompt = backfillScorePrompt({
      title: row.title, summary: row.summary, signals: row.signals,
      playbook: row.playbook, tags: row.tags, source_url: row.source_url
    });
    try {
      // A bare `new AbortController().signal` never fires — a hung DeepSeek call would block
      // this candidate (and the whole script) forever. Bound it the same way the live pipeline
      // bounds its reasoning-step calls (see TIMEOUTS.reason in pipeline.ts).
      const raw = await call.invoke({ prompt, schemaName: "capability_score", schema: scoreResultSchema }, AbortSignal.timeout(TIMEOUTS.reason));
      const parsed = scoreResultSchema.parse(raw.value);
      const sourceFacts = finalizeSourceFacts(parsed.source_facts);
      if (apply) {
        await applyScoreBackfill(pool, row.id, parsed.score, parsed.score_reason, sourceFacts);
      }
      log({ capabilityId: row.id, score: parsed.score, scoreReason: parsed.score_reason, sourceFacts, applied: apply });
      done += 1;
    } catch (error) {
      failed += 1;
      log({ capabilityId: row.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  log({ done, failed, mode: apply ? "apply" : "dry-run" });
  return { candidates: rows.length, done, failed };
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env, "script");
  if (!config.providers.deepseekApiKey) throw new Error("DEEPSEEK_API_KEY required to backfill score");
  const pool = createPool(config.databaseUrl);
  const call = createDeepSeekCall({ apiKey: config.providers.deepseekApiKey });
  const log = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`);
  try {
    const { candidates, done, failed } = await runBackfill(pool, call, apply, log);
    // Every candidate failing (and none succeeding) is the signature of a systemic problem —
    // a bad API key, DeepSeek being down, a schema mismatch — not per-row noise. Exiting non-zero
    // lets a caller (cron, CI, a human watching `$?`) notice instead of reading "done: 0" as fine.
    if (candidates > 0 && done === 0 && failed === candidates) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

// Only run when invoked as a CLI script (`npx tsx scripts/backfill-score.ts`), not when
// imported (e.g. by scripts/backfill-score.test.ts, for applyScoreBackfill).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`backfill-score failed: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
