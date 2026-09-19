import type { Pool } from "pg";
import type { Pipeline } from "../config";
import type { StepName } from "../analysis/steps";

export interface PipelineStat {
  runs: number; done: number; failed: number; avgDurationMs: number;
  /** Tokens of every step (ok or not) of runs that reached done/failed, divided by done + failed. */
  avgTokens: number;
  /** Totals over all steps with token counts, ok or not. */
  inputTokens: number; outputTokens: number;
  /** Part of the totals spent on steps that did not succeed (invalid output, budget, retries). */
  failedAttemptTokens: number;
  /** USD for all tokens, or null when a provider with tokens has no price configured. */
  costUsd: number | null;
  /** USD per finished (done/failed) run, or null as above. */
  costPerRunUsd: number | null;
  stepAvg: Record<ReportedStep, { durationMs: number; tokens: number }>;
}

export interface SpikeReport {
  source: SpikeSource;
  byPipeline: Record<Pipeline, PipelineStat>;
  cards: Array<{ captureId: string; pipeline: Pipeline; title: string; type: string; suggested_verdict: string; confidence: number; tags: string[] }>;
}

/** USD per million tokens, keyed by provider name as recorded in analysis_steps.provider. */
export type SpikePrices = Record<string, { inPerMillion: number; outPerMillion: number }>;

/** Reads SPIKE_PRICE_<PROVIDER>_IN / _OUT (USD per million tokens); a provider needs both to be priced. */
export function spikePricesFromEnv(env: Readonly<Record<string, string | undefined>>): SpikePrices {
  const prices: SpikePrices = {};
  for (const [key, value] of Object.entries(env)) {
    const m = /^SPIKE_PRICE_([A-Z0-9]+)_IN$/.exec(key);
    const out = m ? env[`SPIKE_PRICE_${m[1]}_OUT`] : undefined;
    if (!m || !value || !out) continue;
    const inPerMillion = Number(value);
    const outPerMillion = Number(out);
    if (!Number.isFinite(inPerMillion) || inPerMillion < 0 || !Number.isFinite(outPerMillion) || outPerMillion < 0) {
      throw new Error(`SPIKE_PRICE_${m[1]}_IN/_OUT must be non-negative numbers`);
    }
    prices[m[1].toLowerCase()] = { inPerMillion, outPerMillion };
  }
  return prices;
}

type ReportedStep = Exclude<StepName, "review">;
const PIPELINES: Pipeline[] = ["minimax", "mixed", "minimax_tavily"];
// review is a manual, per-capability action outside the A/B runs, so it never has spike data.
const STEPS: ReportedStep[] = ["vision", "search", "reason"];

/** The capture source a spike run/report is scoped to; 'all' means no source filter. */
export type SpikeSource = "import" | "web" | "telegram" | "all";

/**
 * Builds a `c.source = $n` fragment (or "" for 'all', which applies no source filter) plus
 * the value to push into the query's params, so callers can splice it into a WHERE clause
 * without ever concatenating the source value itself into SQL text.
 */
function sourceFilter(source: SpikeSource, paramIndex: number): { clause: string; params: string[] } {
  if (source === "all") return { clause: "true", params: [] };
  return { clause: `c.source = $${paramIndex}`, params: [source] };
}

/**
 * Enqueues one 'queued' analysis_runs row per (import capture, pipeline) pair, for
 * every pipeline in `pipelines`. Skips a (capture, pipeline) pair that already has a
 * queued/running/done run, so re-running enqueue is idempotent. The generated id is
 * random per row (`md5(random()::text || c.id || pipeline)`), never derived only from
 * capture id + pipeline, so re-enqueuing after a prior spike run (or a concurrent spike
 * against another pipeline set) can never collide with an existing run id.
 *
 * `source` scopes which captures are eligible ('import' by default, matching prior
 * behaviour); 'all' enqueues runs for captures of any source.
 */
/**
 * Parses the pipelines to enqueue from CLI args after `enqueue` (e.g. `["minimax_tavily"]`
 * for `spike.ts enqueue minimax_tavily`). No args (or only "all") enqueues all pipelines.
 */
export function parseEnqueuePipelines(args: readonly string[]): Pipeline[] {
  const requested = args.filter((a) => a !== "all");
  if (requested.length === 0) return [...PIPELINES];
  for (const a of requested) {
    if (!PIPELINES.includes(a as Pipeline)) throw new Error(`unknown pipeline: ${a} (expected one of ${PIPELINES.join(", ")})`);
  }
  return requested as Pipeline[];
}

const SOURCES: SpikeSource[] = ["import", "web", "telegram", "all"];

/** Validates a `--source` CLI value, defaulting to 'import' when none was passed. */
export function parseSpikeSource(value: string | undefined): SpikeSource {
  if (value === undefined) return "import";
  if (!SOURCES.includes(value as SpikeSource)) throw new Error(`unknown source: ${value} (expected one of ${SOURCES.join(", ")})`);
  return value as SpikeSource;
}

export async function enqueueSpikeRuns(pool: Pick<Pool, "query">, pipelines: Pipeline[], source: SpikeSource = "import"): Promise<number> {
  let n = 0;
  const filter = sourceFilter(source, 2);
  for (const pipeline of pipelines) {
    const r = await pool.query(
      `INSERT INTO caphub_v2.analysis_runs (id, capture_id, pipeline, state)
       SELECT 'run_' || substr(md5(random()::text || c.id || $1), 1, 16), c.id, $1, 'queued'
       FROM caphub_v2.captures c
       WHERE ${filter.clause}
         AND NOT EXISTS (
           SELECT 1 FROM caphub_v2.analysis_runs r
           WHERE r.capture_id = c.id AND r.pipeline = $1 AND r.state IN ('queued', 'running', 'done')
         )`,
      [pipeline, ...filter.params]);
    n += r.rowCount ?? 0;
  }
  return n;
}

function emptyPipelineStat(): PipelineStat {
  return {
    runs: 0, done: 0, failed: 0, avgDurationMs: 0, avgTokens: 0, inputTokens: 0, outputTokens: 0, failedAttemptTokens: 0, costUsd: 0, costPerRunUsd: null,
    stepAvg: { vision: { durationMs: 0, tokens: 0 }, search: { durationMs: 0, tokens: 0 }, reason: { durationMs: 0, tokens: 0 } }
  };
}

/**
 * Builds the A/B spike report from analysis_runs/analysis_steps rows, scoped to captures
 * of `source` ('import' by default, matching prior behaviour; 'all' applies no source
 * filter).
 *
 * Cards come from analysis_steps (step = 'reason', ok), not from capabilities: the
 * capabilities table has one row per capture (UNIQUE(capture_id)), so a capture
 * analyzed by both the 'minimax' and 'mixed' pipelines would have the second pipeline's
 * upsert overwrite the first's row there. Reading the reason step's own `output` jsonb
 * (the parsed capability card, recorded by runStructured/recordStep) keeps both
 * pipelines' cards distinct, keyed by (capture, pipeline).
 */
export async function buildSpikeReport(pool: Pick<Pool, "query">, prices: SpikePrices = {}, source: SpikeSource = "import"): Promise<SpikeReport> {
  const filter = sourceFilter(source, 1);

  const runs = (await pool.query<{ pipeline: Pipeline; runs: string; done: string; failed: string; avg_ms: string | null }>(
    `SELECT r.pipeline, count(*)::text AS runs,
            count(*) FILTER (WHERE r.state = 'done')::text AS done,
            count(*) FILTER (WHERE r.state = 'failed')::text AS failed,
            avg(extract(epoch FROM (r.finished_at - r.started_at)) * 1000) FILTER (WHERE r.state = 'done')::text AS avg_ms
     FROM caphub_v2.analysis_runs r
     JOIN caphub_v2.captures c ON c.id = r.capture_id
     WHERE ${filter.clause}
     GROUP BY r.pipeline`,
    filter.params)).rows;

  const steps = (await pool.query<{ pipeline: Pipeline; step: StepName; avg_ms: string; avg_tokens: string }>(
    `SELECT r.pipeline, s.step,
            avg(s.duration_ms)::text AS avg_ms,
            avg(coalesce(s.input_tokens, 0) + coalesce(s.output_tokens, 0))::text AS avg_tokens
     FROM caphub_v2.analysis_steps s
     JOIN caphub_v2.analysis_runs r ON r.id = s.run_id
     JOIN caphub_v2.captures c ON c.id = r.capture_id
     WHERE ${filter.clause} AND s.ok
     GROUP BY r.pipeline, s.step`,
    filter.params)).rows;

  // Token usage of every step with token counts (ok or not), split so the report can show
  // totals, failed-attempt spend, the per-finished-run average and a per-provider cost.
  // Summing per-step averages instead would double count reason retries and search no-ops.
  const usage = (await pool.query<{ pipeline: Pipeline; provider: string; finished: boolean; ok: boolean; input_tokens: string; output_tokens: string }>(
    `SELECT r.pipeline, s.provider, r.state IN ('done', 'failed') AS finished, s.ok,
            sum(coalesce(s.input_tokens, 0))::text AS input_tokens,
            sum(coalesce(s.output_tokens, 0))::text AS output_tokens
     FROM caphub_v2.analysis_steps s
     JOIN caphub_v2.analysis_runs r ON r.id = s.run_id
     JOIN caphub_v2.captures c ON c.id = r.capture_id
     WHERE ${filter.clause} AND (s.input_tokens IS NOT NULL OR s.output_tokens IS NOT NULL)
     GROUP BY r.pipeline, s.provider, finished, s.ok`,
    filter.params)).rows;

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
     WHERE s.step = 'reason' AND s.ok AND ${filter.clause}
     ORDER BY r.capture_id, r.pipeline, s.id DESC`,
    filter.params)).rows;

  const byPipeline = Object.fromEntries(PIPELINES.map((p) => [p, emptyPipelineStat()])) as SpikeReport["byPipeline"];
  for (const r of runs) {
    byPipeline[r.pipeline] = { ...byPipeline[r.pipeline], runs: +r.runs, done: +r.done, failed: +r.failed, avgDurationMs: Math.round(+(r.avg_ms ?? 0)) };
  }
  for (const s of steps) {
    if (s.step !== "review") byPipeline[s.pipeline].stepAvg[s.step] = { durationMs: Math.round(+s.avg_ms), tokens: Math.round(+s.avg_tokens) };
  }
  for (const p of PIPELINES) {
    const x = byPipeline[p];
    const rows = usage.filter((u) => u.pipeline === p).map((u) => ({ ...u, input: +u.input_tokens, output: +u.output_tokens }));
    const cost = (subset: typeof rows): number | null => {
      let usd = 0;
      for (const u of subset) {
        if (u.input + u.output === 0) continue;
        const price = prices[u.provider];
        if (!price) return null;
        usd += (u.input * price.inPerMillion + u.output * price.outPerMillion) / 1_000_000;
      }
      return usd;
    };
    const finishedRows = rows.filter((u) => u.finished);
    const finishedRuns = x.done + x.failed;
    x.inputTokens = rows.reduce((n, u) => n + u.input, 0);
    x.outputTokens = rows.reduce((n, u) => n + u.output, 0);
    x.failedAttemptTokens = rows.filter((u) => !u.ok).reduce((n, u) => n + u.input + u.output, 0);
    x.avgTokens = finishedRuns > 0 ? Math.round(finishedRows.reduce((n, u) => n + u.input + u.output, 0) / finishedRuns) : 0;
    x.costUsd = cost(rows);
    const finishedCost = cost(finishedRows);
    x.costPerRunUsd = finishedRuns > 0 && finishedCost !== null ? finishedCost / finishedRuns : null;
  }

  return { source, byPipeline, cards };
}

const usd = (v: number | null) => (v === null ? "n/a" : `$${v.toFixed(4)}`);

export function renderSpikeMarkdown(r: SpikeReport): string {
  const lines = [
    `# A/B spike 结果（source: ${r.source}）`, "",
    "| pipeline | runs | done | failed | 平均耗时 | 平均 tokens/run | 输入 tokens | 输出 tokens | 失败尝试 tokens | 成本 (USD) | 成本/run (USD) |",
    "|---|---|---|---|---|---|---|---|---|---|---|"
  ];
  for (const p of PIPELINES) {
    const x = r.byPipeline[p];
    lines.push(`| ${p} | ${x.runs} | ${x.done} | ${x.failed} | ${(x.avgDurationMs / 1000).toFixed(1)} s | ${x.avgTokens} | ${x.inputTokens} | ${x.outputTokens} | ${x.failedAttemptTokens} | ${usd(x.costUsd)} | ${usd(x.costPerRunUsd)} |`);
  }
  lines.push("", "平均 tokens/run 与成本/run 按到达 done 或 failed 的 run 计（含失败尝试）；成本按 SPIKE_PRICE_<PROVIDER>_IN/_OUT（USD / 百万 token）计算，未配置则为 n/a。");
  lines.push("", "## 分步平均（成功步骤）", "", "| pipeline | step | 耗时 | tokens |", "|---|---|---|---|");
  for (const p of PIPELINES) for (const s of STEPS) {
    lines.push(`| ${p} | ${s} | ${(r.byPipeline[p].stepAvg[s].durationMs / 1000).toFixed(1)} s | ${r.byPipeline[p].stepAvg[s].tokens} |`);
  }
  lines.push("", "## 卡片(供 Human 打分 1-5)", "", "| capture | pipeline | title | type | 建议 | conf | tags | 评分 |", "|---|---|---|---|---|---|---|---|");
  for (const c of r.cards) lines.push(`| ${c.captureId} | ${c.pipeline} | ${c.title} | ${c.type} | ${c.suggested_verdict} | ${c.confidence.toFixed(2)} | ${c.tags.join(", ")} |  |`);
  return lines.join("\n");
}
