import { describe, expect, it } from "vitest";
import { buildSpikeReport, enqueueSpikeRuns, renderSpikeMarkdown } from "./report";

describe("renderSpikeMarkdown", () => {
  it("renders a per-pipeline table and card list", () => {
    const md = renderSpikeMarkdown({
      byPipeline: {
        minimax: { runs: 2, done: 2, failed: 0, avgDurationMs: 12000, avgTokens: 9000, stepAvg: { vision: { durationMs: 4000, tokens: 3000 }, search: { durationMs: 5000, tokens: 5000 }, reason: { durationMs: 3000, tokens: 1000 }, review: { durationMs: 0, tokens: 0 } } },
        mixed: { runs: 2, done: 1, failed: 1, avgDurationMs: 8000, avgTokens: 4000, stepAvg: { vision: { durationMs: 4000, tokens: 3000 }, search: { durationMs: 1500, tokens: 0 }, reason: { durationMs: 2500, tokens: 1000 }, review: { durationMs: 0, tokens: 0 } } }
      },
      cards: [{ captureId: "cap_1", pipeline: "minimax", title: "t", type: "skill", suggested_verdict: "keep", confidence: 0.9, tags: ["a"] }]
    });
    expect(md).toContain("| minimax | 2 | 2 | 0 | 12.0 s | 9000 |");
    expect(md).toContain("cap_1");
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
  it("aggregates run counts/durations, per-step averages, run-level average tokens, and reason-step cards", async () => {
    const { pool } = fakePool([
      {
        match: "FROM caphub_v2.analysis_runs r",
        rows: [
          { pipeline: "minimax", runs: "2", done: "2", failed: "0", avg_ms: "12000" },
          { pipeline: "mixed", runs: "2", done: "1", failed: "1", avg_ms: "8000" }
        ]
      },
      {
        match: "avg(s.duration_ms)::text AS avg_ms",
        rows: [
          { pipeline: "minimax", step: "vision", avg_ms: "4000", avg_tokens: "3000" },
          { pipeline: "minimax", step: "reason", avg_ms: "3000", avg_tokens: "1000" },
          { pipeline: "mixed", step: "search", avg_ms: "1500", avg_tokens: "0" }
        ]
      },
      {
        match: "sum(coalesce(s.input_tokens, 0) + coalesce(s.output_tokens, 0))::text AS total_tokens",
        rows: [
          { pipeline: "minimax", total_tokens: "18000" },
          { pipeline: "mixed", total_tokens: "4000" }
        ]
      },
      {
        match: "DISTINCT ON (r.capture_id, r.pipeline)",
        rows: [
          { captureId: "cap_1", pipeline: "minimax", title: "t", type: "skill", suggested_verdict: "keep", confidence: 0.9, tags: ["a"] }
        ]
      }
    ]);
    const report = await buildSpikeReport(pool);
    expect(report.byPipeline.minimax).toMatchObject({ runs: 2, done: 2, failed: 0, avgDurationMs: 12000, avgTokens: 9000 });
    expect(report.byPipeline.minimax.stepAvg.vision).toEqual({ durationMs: 4000, tokens: 3000 });
    expect(report.byPipeline.minimax.stepAvg.reason).toEqual({ durationMs: 3000, tokens: 1000 });
    // mixed: total tokens (4000) / done runs (1) = 4000, NOT the sum of per-step averages (which would double count retries/no-ops).
    expect(report.byPipeline.mixed).toMatchObject({ runs: 2, done: 1, failed: 1, avgDurationMs: 8000, avgTokens: 4000 });
    expect(report.cards).toEqual([{ captureId: "cap_1", pipeline: "minimax", title: "t", type: "skill", suggested_verdict: "keep", confidence: 0.9, tags: ["a"] }]);
  });

  it("defaults a pipeline with no runs/steps/tokens to zeroed stats, avoiding divide-by-zero", async () => {
    const { pool } = fakePool([
      { match: "FROM caphub_v2.analysis_runs r", rows: [] },
      { match: "avg(s.duration_ms)::text AS avg_ms", rows: [] },
      { match: "sum(coalesce(s.input_tokens, 0) + coalesce(s.output_tokens, 0))::text AS total_tokens", rows: [{ pipeline: "mixed", total_tokens: "500" }] },
      { match: "DISTINCT ON (r.capture_id, r.pipeline)", rows: [] }
    ]);
    const report = await buildSpikeReport(pool);
    expect(report.byPipeline.minimax).toMatchObject({ runs: 0, done: 0, failed: 0, avgDurationMs: 0, avgTokens: 0 });
    // mixed has token totals but 0 done runs: avgTokens must stay 0, not divide by zero / Infinity.
    expect(report.byPipeline.mixed.avgTokens).toBe(0);
  });
});
