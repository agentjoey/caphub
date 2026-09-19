import { describe, expect, it } from "vitest";
import type { Card } from "./card";
import { upsertCapability } from "./capabilities";

const card: Card = {
  title: "t", type: "prompt", summary: "s", signals: ["a", "b"], suggested_verdict: "keep", suggested_reason: "r",
  confidence: 0.9, usage: "integrate", playbook: { kind: "integrate", install: [], repo: null, prompt_text: "p" }, tags: ["x"], source_url: null
};

describe("upsertCapability", () => {
  it("reports previousVerdict null and deleted false for a brand-new row", async () => {
    let sql = "";
    const pool = {
      query: async (text: string) => {
        sql = text;
        return { rows: [{ id: "cab_1", verdict: "keep", previous_verdict: null, deleted: false }] };
      }
    };
    const out = await upsertCapability(pool as never, { captureId: "cap_1", runId: "run_1", card, verdict: "keep", verdictBy: "auto" });
    expect(sql).toContain("WITH prev AS");
    expect(sql).toContain("INSERT INTO caphub_v2.capabilities");
    expect(out).toEqual({ id: "cab_1", verdict: "keep", previousVerdict: null, deleted: false });
  });

  it("surfaces the prior row's verdict and deleted state on a re-run", async () => {
    const pool = {
      query: async () => ({ rows: [{ id: "cab_1", verdict: "keep", previous_verdict: "pending", deleted: true }] })
    };
    const out = await upsertCapability(pool as never, { captureId: "cap_1", runId: "run_2", card, verdict: "keep", verdictBy: "auto" });
    expect(out).toEqual({ id: "cab_1", verdict: "keep", previousVerdict: "pending", deleted: true });
  });
});
