import { describe, expect, it } from "vitest";
import { buildSpikeReport, enqueueSpikeRuns, renderSpikeMarkdown, spikePricesFromEnv } from "./report";

describe("renderSpikeMarkdown", () => {
  const stepAvg = { vision: { durationMs: 4000, tokens: 3000 }, search: { durationMs: 5000, tokens: 5000 }, reason: { durationMs: 3000, tokens: 1000 } };
  const report = {
    byPipeline: {
      minimax: { runs: 2, done: 2, failed: 0, avgDurationMs: 12000, avgTokens: 9000, inputTokens: 15000, outputTokens: 3000, failedAttemptTokens: 500, costUsd: 0.0123, costPerRunUsd: 0.00615, stepAvg },
      mixed: { runs: 2, done: 1, failed: 1, avgDurationMs: 8000, avgTokens: 4000, inputTokens: 7000, outputTokens: 1000, failedAttemptTokens: 0, costUsd: null, costPerRunUsd: null, stepAvg }
    },
    cards: [{ captureId: "cap_1", pipeline: "minimax" as const, title: "t", type: "skill", suggested_verdict: "keep", confidence: 0.9, tags: ["a"] }]
  };

  it("renders per-pipeline tokens split, failed-attempt tokens, cost (n/a when unpriced) and the card list", () => {
    const md = renderSpikeMarkdown(report);
    expect(md).toContain("| minimax | 2 | 2 | 0 | 12.0 s | 9000 | 15000 | 3000 | 500 | $0.0123 | $0.0062 |");
    expect(md).toContain("| mixed | 2 | 1 | 1 | 8.0 s | 4000 | 7000 | 1000 | 0 | n/a | n/a |");
    expect(md).toContain("cap_1");
  });

  it("drops the review step row", () => {
    expect(renderSpikeMarkdown(report)).not.toMatch(/\| review \|/);
  });
});

describe("spikePricesFromEnv", () => {
  it("reads per-provider USD per million token prices, requiring both IN and OUT", () => {
    expect(spikePricesFromEnv({ SPIKE_PRICE_MINIMAX_IN: "0.3", SPIKE_PRICE_MINIMAX_OUT: "1.2", SPIKE_PRICE_DEEPSEEK_IN: "0.1", OTHER: "x" }))
      .toEqual({ minimax: { inPerMillion: 0.3, outPerMillion: 1.2 } });
  });
  it("rejects non-numeric prices", () => {
    expect(() => spikePricesFromEnv({ SPIKE_PRICE_MINIMAX_IN: "cheap", SPIKE_PRICE_MINIMAX_OUT: "1" })).toThrow(/SPIKE_PRICE_MINIMAX/);
  });
});

function fakePool(handlers: Array<{ match: string; rows: unknown[]; rowCount?: number }>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      const h = handlers.find((h) => text.includes(h.match));
      if (!h) throw new Error(`unexpected query: ${text}`);
      return { rows: h.rows, rowCount: h.rowCount ?? h.rows.length };
    }
  };
  return { pool: pool as never, calls };
}

describe("enqueueSpikeRuns", () => {
  it("inserts one queued run per import capture for each pipeline, skipping existing queued/running/done runs", async () => {
    const { pool, calls } = fakePool([
      { match: "INSERT INTO caphub_v2.analysis_runs", rows: [], rowCount: 3 }
    ]);
    const n = await enqueueSpikeRuns(pool, ["minimax", "mixed"]);
    expect(n).toBe(6);
    expect(calls).toHaveLength(2);
    expect(calls[0].values).toEqual(["minimax"]);
    expect(calls[1].values).toEqual(["mixed"]);
    for (const c of calls) {
      expect(c.text).toContain("'run_' || substr(md5(random()::text || c.id || $1), 1, 16)");
      expect(c.text).toContain("WHERE c.source = 'import'");
      expect(c.text).toContain("r.pipeline = $1 AND r.state IN ('queued', 'running', 'done')");
    }
  });

  it("generates a fresh random id per row rather than a deterministic capture+pipeline id, so re-enqueuing never collides", async () => {
    const { pool, calls } = fakePool([{ match: "INSERT INTO caphub_v2.analysis_runs", rows: [], rowCount: 0 }]);
    await enqueueSpikeRuns(pool, ["minimax"]);
    // R15: the id expression must include `random()`, not just capture id + pipeline.
    expect(calls[0].text).toMatch(/md5\(random\(\)::text \|\| c\.id \|\| \$1\)/);
  });
});

describe("buildSpikeReport", () => {
  const runsRows = [
    { pipeline: "minimax", runs: "3", done: "2", failed: "0", avg_ms: "12000" },
    { pipeline: "mixed", runs: "2", done: "1", failed: "1", avg_ms: "8000" }
  ];
  const stepRows = [
    { pipeline: "minimax", step: "vision", avg_ms: "4000", avg_tokens: "3000" },
    { pipeline: "minimax", step: "reason", avg_ms: "3000", avg_tokens: "1000" },
    { pipeline: "mixed", step: "search", avg_ms: "1500", avg_tokens: "0" }
  ];
  // minimax: 2 done runs (finished) + 1 still running (unfinished); one failed reason attempt.
  // mixed: done + failed run; the failed run's reason attempt spent tokens; tavily search has 0 tokens.
  const usageRows = [
    { pipeline: "minimax", provider: "minimax", finished: true, ok: true, input_tokens: "14000", output_tokens: "3000" },
    { pipeline: "minimax", provider: "minimax", finished: true, ok: false, input_tokens: "900", output_tokens: "100" },
    { pipeline: "minimax", provider: "minimax", finished: false, ok: true, input_tokens: "500", output_tokens: "0" },
    { pipeline: "mixed", provider: "minimax", finished: true, ok: true, input_tokens: "2000", output_tokens: "500" },
    { pipeline: "mixed", provider: "deepseek", finished: true, ok: false, input_tokens: "3000", output_tokens: "500" },
    { pipeline: "mixed", provider: "tavily", finished: true, ok: true, input_tokens: "0", output_tokens: "0" }
  ];
  const cardRows = [{ captureId: "cap_1", pipeline: "minimax", title: "t", type: "skill", suggested_verdict: "keep", confidence: 0.9, tags: ["a"] }];
  const handlers = (usage: unknown[] = usageRows) => [
    { match: "FROM caphub_v2.analysis_runs r", rows: runsRows },
    { match: "avg(s.duration_ms)::text AS avg_ms", rows: stepRows },
    { match: "sum(coalesce(s.input_tokens, 0))::text AS input_tokens", rows: usage },
    { match: "DISTINCT ON (r.capture_id, r.pipeline)", rows: cardRows }
  ];

  it("counts all steps with tokens (ok or not), averages over done+failed runs, and splits input/output and failed-attempt tokens", async () => {
    const { pool, calls } = fakePool(handlers());
    const report = await buildSpikeReport(pool);
    const usageSql = calls.find((c) => c.text.includes("AS input_tokens"))!.text;
    expect(usageSql).not.toMatch(/AND s\.ok/);
    expect(usageSql).toContain("s.input_tokens IS NOT NULL OR s.output_tokens IS NOT NULL");
    expect(usageSql).toContain("r.state IN ('done', 'failed') AS finished");
    // minimax: (14000 + 3000 + 900 + 100) finished tokens / (2 done + 0 failed) = 9000
    expect(report.byPipeline.minimax).toMatchObject({ runs: 3, done: 2, failed: 0, avgDurationMs: 12000, avgTokens: 9000, inputTokens: 15400, outputTokens: 3100, failedAttemptTokens: 1000 });
    // mixed: (2500 + 3500 + 0) / (1 done + 1 failed) = 3000
    expect(report.byPipeline.mixed).toMatchObject({ runs: 2, done: 1, failed: 1, avgTokens: 3000, inputTokens: 5000, outputTokens: 1000, failedAttemptTokens: 3500 });
    expect(report.byPipeline.minimax.stepAvg.vision).toEqual({ durationMs: 4000, tokens: 3000 });
    expect(report.byPipeline.minimax.stepAvg).not.toHaveProperty("review");
    expect(report.cards).toEqual(cardRows);
  });

  it("prices tokens per provider, ignoring zero-token providers, and is null when a provider with tokens is unpriced", async () => {
    const prices = { minimax: { inPerMillion: 1, outPerMillion: 10 }, deepseek: { inPerMillion: 2, outPerMillion: 20 } };
    const { pool } = fakePool(handlers());
    const report = await buildSpikeReport(pool, prices);
    // minimax: 15400 * 1 + 3100 * 10 = 46400 → $0.0464; finished part 14900 + 31000 = 45900 / 2 runs
    expect(report.byPipeline.minimax.costUsd).toBeCloseTo(0.0464, 10);
    expect(report.byPipeline.minimax.costPerRunUsd).toBeCloseTo(0.02295, 10);
    // mixed: minimax 2000 + 5000 = 7000; deepseek 6000 + 10000 = 16000; tavily has 0 tokens → no price needed
    expect(report.byPipeline.mixed.costUsd).toBeCloseTo(0.023, 10);
    expect(report.byPipeline.mixed.costPerRunUsd).toBeCloseTo(0.0115, 10);

    const unpriced = await buildSpikeReport(fakePool(handlers()).pool, { minimax: prices.minimax });
    expect(unpriced.byPipeline.minimax.costUsd).toBeCloseTo(0.0464, 10);
    expect(unpriced.byPipeline.mixed).toMatchObject({ costUsd: null, costPerRunUsd: null });
  });

  it("defaults a pipeline with no runs/steps/tokens to zeroed stats, avoiding divide-by-zero", async () => {
    const { pool } = fakePool([
      { match: "FROM caphub_v2.analysis_runs r", rows: [] },
      { match: "avg(s.duration_ms)::text AS avg_ms", rows: [] },
      { match: "sum(coalesce(s.input_tokens, 0))::text AS input_tokens", rows: [{ pipeline: "mixed", provider: "minimax", finished: false, ok: true, input_tokens: "500", output_tokens: "0" }] },
      { match: "DISTINCT ON (r.capture_id, r.pipeline)", rows: [] }
    ]);
    const report = await buildSpikeReport(pool, { minimax: { inPerMillion: 1, outPerMillion: 1 } });
    expect(report.byPipeline.minimax).toMatchObject({ runs: 0, done: 0, failed: 0, avgDurationMs: 0, avgTokens: 0, inputTokens: 0, costUsd: 0, costPerRunUsd: null });
    // mixed has tokens but no finished runs: avgTokens stays 0 and per-run cost is n/a, not Infinity.
    expect(report.byPipeline.mixed).toMatchObject({ avgTokens: 0, inputTokens: 500, costPerRunUsd: null });
  });
});
