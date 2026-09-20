import type { Pool } from "pg";
import { finalizeSourceFacts, scoreResultSchema, type SourceFacts } from "../lib/analysis/card";
import { backfillScorePrompt } from "../lib/analysis/prompts";
import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { createDeepSeekCall } from "../lib/providers/deepseek";

function parseArgs(args: string[]): { apply: boolean } {
  return { apply: args.includes("--apply") };
}

/**
 * Writes the backfilled score for one card. Only `score`, `score_reason` and `source_facts`
 * are touched: this is a one-off scoring pass over already-built cards, not a re-analysis, so
 * `updated_at` (and everything else the card contains) must not move.
 */
export function applyScoreBackfill(
  pool: Pick<Pool, "query">, id: string, score: number, scoreReason: string, sourceFacts: SourceFacts
) {
  return pool.query(
    "UPDATE caphub_v2.capabilities SET score = $2, score_reason = $3, source_facts = $4 WHERE id = $1",
    [id, score, scoreReason, sourceFacts]
  );
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env, "script");
  if (!config.providers.deepseekApiKey) throw new Error("DEEPSEEK_API_KEY required to backfill score");
  const pool = createPool(config.databaseUrl);
  const call = createDeepSeekCall({ apiKey: config.providers.deepseekApiKey });
  const log = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`);
  try {
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
        const raw = await call.invoke({ prompt, schemaName: "capability_score", schema: scoreResultSchema }, new AbortController().signal);
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
