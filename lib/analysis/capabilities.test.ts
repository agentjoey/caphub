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
    expect(sql).toContain("review_error = NULL");
    expect(sql).toContain("review_requested_at = NULL");
    expect(out).toEqual({ id: "cab_1", verdict: "keep", previousVerdict: null, deleted: false });
  });

  it("surfaces the prior row's verdict and deleted state on a re-run", async () => {
    const pool = {
      query: async () => ({ rows: [{ id: "cab_1", verdict: "keep", previous_verdict: "pending", deleted: true }] })
    };
    const out = await upsertCapability(pool as never, { captureId: "cap_1", runId: "run_2", card, verdict: "keep", verdictBy: "auto" });
    expect(out).toEqual({ id: "cab_1", verdict: "keep", previousVerdict: "pending", deleted: true });
  });

  it("strips U+0000 from every text and jsonb parameter before it reaches SQL", async () => {
    let params: unknown[] = [];
    const pool = {
      query: async (_text: string, values: unknown[]) => {
        params = values;
        return { rows: [{ id: "cab_1", verdict: "keep", previous_verdict: null, deleted: false }] };
      }
    };
    const dirty: Card = {
      ...card,
      title: "t\u0000itle", summary: "s\u0000ummary", signals: ["a\u0000", "b"], suggested_reason: "r\u0000eason",
      playbook: { kind: "integrate", install: [], repo: null, prompt_text: "p\u0000" }, tags: ["x\u0000"], source_url: "https://a.b/\u0000"
    };
    await upsertCapability(pool as never, { captureId: "cap_1", runId: "run_1", card: dirty, verdict: "keep", verdictBy: "auto" });
    for (const p of params) {
      if (typeof p === "string") expect(p).not.toContain("\u0000");
      if (Array.isArray(p)) for (const item of p) expect(String(item)).not.toContain("\u0000");
    }
    expect(params[3]).toBe("title");
    expect(params[5]).toBe("summary");
    expect(JSON.parse(params[6] as string)).toEqual(["a", "b"]);
    expect(params[8]).toBe("reason");
    expect(JSON.parse(params[13] as string)).toEqual({ kind: "integrate", install: [], repo: null, prompt_text: "p" });
    expect(params[14]).toEqual(["x"]);
    expect(params[15]).toBe("https://a.b/");
  });
});
