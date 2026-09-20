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
    expect(params).toEqual(["cab_1", 4, "有仓库和安装命令，可复现性高", sourceFacts]);
  });
});
