import { describe, expect, it } from "vitest";
import { applyScoreBackfill } from "./backfill-score";

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
