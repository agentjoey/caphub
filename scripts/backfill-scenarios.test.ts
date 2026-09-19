import { describe, expect, it } from "vitest";
import { applyScenarioBackfill } from "./backfill-scenarios";

describe("applyScenarioBackfill", () => {
  it("sets scenarios and clears embedding/embedded_at, without touching updated_at", async () => {
    let sql = "";
    let params: unknown[] = [];
    const pool = {
      query: async (text: string, values: unknown[]) => {
        sql = text;
        params = values;
        return { rows: [] };
      }
    };
    await applyScenarioBackfill(pool as never, "cab_1", ["video"]);
    expect(sql).toContain("SET scenarios = $2");
    expect(sql).toContain("embedding = NULL");
    expect(sql).toContain("embedded_at = NULL");
    expect(sql).not.toContain("updated_at");
    expect(params).toEqual(["cab_1", ["video"]]);
  });
});
