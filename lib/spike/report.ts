import type { Pool } from "pg";
import type { Pipeline } from "../config";
import type { StepName } from "../analysis/steps";

export interface SpikeReport {
  byPipeline: Record<Pipeline, {
    runs: number; done: number; failed: number; avgDurationMs: number; avgTokens: number;
    stepAvg: Record<StepName, { durationMs: number; tokens: number }>;
  }>;
  cards: Array<{ captureId: string; pipeline: Pipeline; title: string; type: string; suggested_verdict: string; confidence: number; tags: string[] }>;
}

const PIPELINES: Pipeline[] = ["minimax", "mixed"];
const STEPS: StepName[] = ["vision", "search", "reason", "review"];

/**
 * Enqueues one 'queued' analysis_runs row per (import capture, pipeline) pair, for
 * every pipeline in `pipelines`. Skips a (capture, pipeline) pair that already has a
 * queued/running/done run, so re-running enqueue is idempotent. The generated id is
 * random per row (`md5(random()::text || c.id || pipeline)`), never derived only from
 * capture id + pipeline, so re-enqueuing after a prior spike run (or a concurrent spike
 * against another pipeline set) can never collide with an existing run id.
 */
export async function enqueueSpikeRuns(pool: Pick<Pool, "query">, pipelines: Pipeline[]): Promise<number> {
  let n = 0;
  for (const pipeline of pipelines) {
    const r = await pool.query(
      `INSERT INTO caphub_v2.analysis_runs (id, capture_id, pipeline, state)
       SELECT 'run_' || substr(md5(random()::text || c.id || $1), 1, 16), c.id, $1, 'queued'
       FROM caphub_v2.captures c
       WHERE c.source = 'import'
         AND NOT EXISTS (
           SELECT 1 FROM caphub_v2.analysis_runs r
           WHERE r.capture_id = c.id AND r.pipeline = $1 AND r.state IN ('queued', 'running', 'done')
         )`,
      [pipeline]);
    n += r.rowCount ?? 0;
  }
  return n;
}

function emptyPipelineStat(): SpikeReport["byPipeline"][Pipeline] {
  return {
    runs: 0, done: 0, failed: 0, avgDurationMs: 0, avgTokens: 0,
    stepAvg: { vision: { durationMs: 0, tokens: 0 }, search: { durationMs: 0, tokens: 0 }, reason: { durationMs: 0, tokens: 0 }, review: { durationMs: 0, tokens: 0 } }
  };
}

/**
 * Builds the A/B spike report from import-sourced analysis_runs/analysis_steps rows.
 *
 * Cards come from analysis_steps (step = 'reason', ok), not from capabilities: the
 * capabilities table has one row per capture (UNIQUE(capture_id)), so a capture
 * analyzed by both the 'minimax' and 'mixed' pipelines would have the second pipeline's
 * upsert overwrite the first's row there. Reading the reason step's own `output` jsonb
 * (the parsed capability card, recorded by runStructured/recordStep) keeps both
 * pipelines' cards distinct, keyed by (capture, pipeline).
 */
export async function buildSpikeReport(pool: Pick<Pool, "query">): Promise<SpikeReport> {
  const runs = (await pool.query<{ pipeline: Pipeline; runs: string; done: string; failed: string; avg_ms: string | null }>(
    `SELECT r.pipeline, count(*)::text AS runs,
            count(*) FILTER (WHERE r.state = 'done')::text AS done,
            count(*) FILTER (WHERE r.state = 'failed')::text AS failed,
            avg(extract(epoch FROM (r.finished_at - r.started_at)) * 1000) FILTER (WHERE r.state = 'done')::text AS avg_ms
     FROM caphub_v2.analysis_runs r
     JOIN caphub_v2.captures c ON c.id = r.capture_id
     WHERE c.source = 'import'
     GROUP BY r.pipeline`)).rows;

  const steps = (await pool.query<{ pipeline: Pipeline; step: StepName; avg_ms: string; avg_tokens: string }>(
    `SELECT r.pipeline, s.step,
            avg(s.duration_ms)::text AS avg_ms,
            avg(coalesce(s.input_tokens, 0) + coalesce(s.output_tokens, 0))::text AS avg_tokens
     FROM caphub_v2.analysis_steps s
     JOIN caphub_v2.analysis_runs r ON r.id = s.run_id
     JOIN caphub_v2.captures c ON c.id = r.capture_id
     WHERE c.source = 'import' AND s.ok
     GROUP BY r.pipeline, s.step`)).rows;

  // Total tokens of ok steps per pipeline, divided below by that pipeline's done-run
  // count. This (not a sum of the per-step averages above) is the report's "avg tokens
  // per run" figure: summing per-step averages double counts, since a run's reason step
  // can retry (attempt 1 failing INVALID_OUTPUT, attempt 2 ok) and search can be a
  // no-op with 0 tokens, so per-step averages are not directly additive into a
  // per-run total.
  const tokenTotals = (await pool.query<{ pipeline: Pipeline; total_tokens: string }>(
    `SELECT r.pipeline, sum(coalesce(s.input_tokens, 0) + coalesce(s.output_tokens, 0))::text AS total_tokens
     FROM caphub_v2.analysis_steps s
     JOIN caphub_v2.analysis_runs r ON r.id = s.run_id
     JOIN caphub_v2.captures c ON c.id = r.capture_id
     WHERE c.source = 'import' AND s.ok
     GROUP BY r.pipeline`)).rows;

  const cards = (await pool.query<SpikeReport["cards"][number]>(
    `SELECT DISTINCT ON (r.capture_id, r.pipeline)
            r.capture_id AS "captureId", r.pipeline,
            s.output ->> 'title' AS title,
            s.output ->> 'type' AS type,
            s.output ->> 'suggested_verdict' AS suggested_verdict,
            (s.output ->> 'confidence')::float AS confidence,
            s.output -> 'tags' AS tags
     FROM caphub_v2.analysis_steps s
     JOIN caphub_v2.analysis_runs r ON r.id = s.run_id
     JOIN caphub_v2.captures c ON c.id = r.capture_id
     WHERE s.step = 'reason' AND s.ok AND c.source = 'import'
     ORDER BY r.capture_id, r.pipeline, s.id DESC`)).rows;

  const byPipeline = Object.fromEntries(PIPELINES.map((p) => [p, emptyPipelineStat()])) as SpikeReport["byPipeline"];
  for (const r of runs) {
    byPipeline[r.pipeline] = { ...byPipeline[r.pipeline], runs: +r.runs, done: +r.done, failed: +r.failed, avgDurationMs: Math.round(+(r.avg_ms ?? 0)) };
  }
  for (const s of steps) byPipeline[s.pipeline].stepAvg[s.step] = { durationMs: Math.round(+s.avg_ms), tokens: Math.round(+s.avg_tokens) };
  for (const t of tokenTotals) {
    const done = byPipeline[t.pipeline].done;
    byPipeline[t.pipeline].avgTokens = done > 0 ? Math.round(+t.total_tokens / done) : 0;
  }

  return { byPipeline, cards };
}

export function renderSpikeMarkdown(r: SpikeReport): string {
  const lines = ["# A/B spike 结果", "", "| pipeline | runs | done | failed | 平均耗时 | 平均 tokens |", "|---|---|---|---|---|---|"];
  for (const p of PIPELINES) {
    const x = r.byPipeline[p];
    lines.push(`| ${p} | ${x.runs} | ${x.done} | ${x.failed} | ${(x.avgDurationMs / 1000).toFixed(1)} s | ${x.avgTokens} |`);
  }
  lines.push("", "## 分步平均", "", "| pipeline | step | 耗时 | tokens |", "|---|---|---|---|");
  for (const p of PIPELINES) for (const s of STEPS) {
    lines.push(`| ${p} | ${s} | ${(r.byPipeline[p].stepAvg[s].durationMs / 1000).toFixed(1)} s | ${r.byPipeline[p].stepAvg[s].tokens} |`);
  }
  lines.push("", "## 卡片(供 Human 打分 1-5)", "", "| capture | pipeline | title | type | 建议 | conf | tags | 评分 |", "|---|---|---|---|---|---|---|---|");
  for (const c of r.cards) lines.push(`| ${c.captureId} | ${c.pipeline} | ${c.title} | ${c.type} | ${c.suggested_verdict} | ${c.confidence.toFixed(2)} | ${c.tags.join(", ")} |  |`);
  return lines.join("\n");
}
