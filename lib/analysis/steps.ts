import type { Pool } from "pg";
import { jsonStringifyStripNul, stripNul } from "../text/sanitize";

// "plan" and "synthesize" are the deep-analysis pipeline's steps (lib/analysis/deep.ts);
// the analysis_steps.step CHECK was widened to allow them by migration 010. "fetch" is the
// enrichment pipeline's canonical-source fetch (lib/analysis/enrich.ts), added by migration 011.
export type StepName = "vision" | "search" | "reason" | "review" | "plan" | "synthesize" | "fetch";

export interface StepRow {
  runId: string; step: StepName; provider: string; model: string; attempt: number;
  inputTokens?: number; outputTokens?: number; durationMs: number; ok: boolean; error?: string; output?: unknown;
}

export async function recordStep(pool: Pick<Pool, "query">, row: StepRow): Promise<void> {
  await pool.query(
    `INSERT INTO caphub_v2.analysis_steps (run_id, step, provider, model, attempt, input_tokens, output_tokens, duration_ms, ok, error, output)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [row.runId, row.step, row.provider, row.model, row.attempt, row.inputTokens ?? null, row.outputTokens ?? null,
      row.durationMs, row.ok, row.error === undefined ? null : stripNul(row.error),
      row.output === undefined ? null : jsonStringifyStripNul(row.output)]);
}
