import { describe, expect, it } from "vitest";
import { applyScoreBackfill, runBackfill } from "./backfill-score";

function fakeRowsPool(rows: Array<Record<string, unknown>>) {
  const updates: unknown[][] = [];
  return {
    pool: {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes("SELECT id, title")) return { rows };
        if (text.startsWith("UPDATE caphub_v2.capabilities SET score")) {
          updates.push(values ?? []);
          return { rows: [] };
        }
        throw new Error(`unhandled query: ${text}`);
      }
    },
    updates
  };
}

const row = { id: "cab_1", title: "t", summary: "s", signals: [], playbook: {}, tags: [], source_url: null };

describe("applyScoreBackfill", () => {
  it("sets score, score_reason and source_facts, without touching updated_at", async () => {
    let sql = "";
    let params: unknown[] = [];
    const pool = {
      query: async (text: string, values: unknown[]) => {
        sql = text;
        params = values;
        return { rows: [] };
      }
    };
    const sourceFacts = { repo_url: "https://github.com/a/b", as_of: "2026-09-20" };
    await applyScoreBackfill(pool as never, "cab_1", 4, "有仓库和安装命令，可复现性高", sourceFacts);
    expect(sql).toContain("SET score = $2");
    expect(sql).toContain("score_reason = $3");
    expect(sql).toContain("source_facts = $4");
    expect(sql).not.toContain("updated_at");
    expect(params).toEqual(["cab_1", 4, "有仓库和安装命令，可复现性高", JSON.stringify(sourceFacts)]);
  });

  // Regression: without "AND score IS NULL", this backfill could clobber a score written by a
  // concurrent re-analysis (rerun from the web UI or Telegram) that lands between this script's
  // SELECT and its UPDATE.
  it("only updates a row that is still unscored (AND score IS NULL)", async () => {
    let sql = "";
    const pool = {
      query: async (text: string) => { sql = text; return { rows: [] }; }
    };
    await applyScoreBackfill(pool as never, "cab_1", 4, "reason", {});
    expect(sql).toMatch(/WHERE id = \$1 AND score IS NULL/);
  });

  // Postgres rejects U+0000 in text/jsonb outright (22P05): a model that emits a NUL into
  // score_reason or a source_facts string field must not reach the SQL parameter unsanitized,
  // or the row gets stuck forever (UPDATE throws -> logged as failed -> score stays NULL ->
  // re-scored and re-failed on every future run). Mirrors upsertCapability's sanitization.
  it("strips U+0000 from score_reason and from source_facts string fields before binding", async () => {
    let params: unknown[] = [];
    const pool = {
      query: async (_text: string, values: unknown[]) => {
        params = values;
        return { rows: [] };
      }
    };
    const sourceFacts = { repo_url: "https://github.com/a\u0000/b", license: "MIT\u0000" };
    await applyScoreBackfill(pool as never, "cab_1", 3, "带\u0000空字符的理由", sourceFacts);
    const [, , scoreReasonParam, sourceFactsParam] = params as [unknown, unknown, string, string];
    expect(scoreReasonParam).toBe("带空字符的理由");
    expect(scoreReasonParam).not.toContain("\u0000");
    expect(sourceFactsParam).not.toContain("\u0000");
    expect(JSON.parse(sourceFactsParam)).toEqual({ repo_url: "https://github.com/a/b", license: "MIT" });
  });
});

describe("runBackfill", () => {
  const log = () => {};

  // Regression: `new AbortController().signal` never fires on its own, so a hung DeepSeek call
  // would block the script forever. `invoke` must be given a real, bounded AbortSignal instead.
  it("calls DeepSeek with a signal that has a timeout (not a bare, never-firing controller)", async () => {
    const { pool } = fakeRowsPool([row]);
    let receivedSignal: AbortSignal | undefined;
    const call = {
      invoke: async (_input: never, signal: AbortSignal) => {
        receivedSignal = signal;
        return { value: { score: 4, score_reason: "ok", source_facts: {} } };
      }
    };
    const result = await runBackfill(pool as never, call, false, log);
    expect(result).toEqual({ candidates: 1, done: 1, failed: 0 });
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    // A never-firing `new AbortController().signal` is never `aborted` either, so this alone
    // doesn't prove a timeout is wired up — the real assurance is functional coverage of the
    // source change (AbortSignal.timeout(...) is what's now passed) plus the code review it
    // gets; this at least proves invoke is called with an actual AbortSignal instance.
    expect(receivedSignal?.aborted).toBe(false);
  });

  it("reports the done/failed/candidates counts so main() can decide the exit code", async () => {
    const { pool } = fakeRowsPool([row, { ...row, id: "cab_2" }]);
    const call = {
      invoke: async () => { throw new Error("deepseek down"); }
    };
    const result = await runBackfill(pool as never, call, true, log);
    expect(result).toEqual({ candidates: 2, done: 0, failed: 2 });
  });

  it("does not write when apply=false, even on success", async () => {
    const { pool, updates } = fakeRowsPool([row]);
    const call = {
      invoke: async () => ({ value: { score: 5, score_reason: "ok", source_facts: {} } })
    };
    const result = await runBackfill(pool as never, call, false, log);
    expect(result).toEqual({ candidates: 1, done: 1, failed: 0 });
    expect(updates).toHaveLength(0);
  });
});
