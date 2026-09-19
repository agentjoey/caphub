import { describe, expect, it } from "vitest";
import type { Card } from "./card";
import { upsertCapability } from "./capabilities";

const card: Card = {
  title: "t", type: "prompt", summary: "s", signals: ["a", "b"], suggested_verdict: "keep", suggested_reason: "r",
  confidence: 0.9, usage: "integrate", playbook: { kind: "integrate", install: [], repo: null, prompt_text: "p" }, tags: ["x"], source_url: null,
  scenarios: ["coding"]
};

describe("upsertCapability", () => {
  it("reports previousVerdict null and deleted false for a brand-new row", async () => {
    let sql = "";
    const pool = {
      query: async (text: string) => {
        if (sql === "") sql = text; // capture the upsert only; ignore the follow-up serial UPDATE
        return { rows: [{ id: "cab_1", verdict: "keep", previous_verdict: null, deleted: false }] };
      }
    };
    const out = await upsertCapability(pool as never, { captureId: "cap_1", runId: "run_1", card, verdict: "keep", verdictBy: "auto" });
    expect(sql).toContain("WITH prev AS");
    expect(sql).toContain("INSERT INTO caphub_v2.capabilities");
    expect(sql).toContain("review_error = NULL");
    expect(sql).toContain("review_requested_at = NULL");
    expect(sql).toContain("scenarios = excluded.scenarios");
    expect(out).toEqual({ id: "cab_1", verdict: "keep", previousVerdict: null, deleted: false });
  });

  it("never evaluates nextval() in the INSERT's VALUES, so a conflicting re-run can't burn a serial", async () => {
    const calls: string[] = [];
    const pool = {
      query: async (text: string) => {
        calls.push(text);
        return { rows: [{ id: "cab_1", verdict: "keep", previous_verdict: "keep", deleted: false }] };
      }
    };
    await upsertCapability(pool as never, { captureId: "cap_1", runId: "run_1", card, verdict: "keep", verdictBy: "auto" });
    const [upsertSql, followUpSql] = calls;
    // VALUES always passes a literal NULL for serial; nextval() never appears in the INSERT list.
    expect(upsertSql).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12,[\s\S]*?\n\s*NULL\)/);
    expect(upsertSql.split("VALUES")[1]).not.toContain("nextval");
    // ON CONFLICT keeps whatever serial the row already has.
    expect(upsertSql).toContain("serial = coalesce(caphub_v2.capabilities.serial, excluded.serial)");
    // The follow-up UPDATE is the only place nextval() runs, gated so it only ever assigns a
    // number to a keep row that doesn't have one yet — a re-run of an already-numbered keep
    // card is a no-op.
    expect(followUpSql).toContain("nextval('caphub_v2.capability_serial')");
    expect(followUpSql).toMatch(/WHERE id = \$1 AND verdict = 'keep' AND serial IS NULL/);
    expect(followUpSql).not.toContain("updated_at");
  });

  it("skips the follow-up serial UPDATE entirely when the resulting verdict is discard", async () => {
    const calls: string[] = [];
    const pool = {
      query: async (text: string) => {
        calls.push(text);
        return { rows: [{ id: "cab_1", verdict: "discard", previous_verdict: null, deleted: false }] };
      }
    };
    await upsertCapability(pool as never, { captureId: "cap_1", runId: "run_1", card, verdict: "discard", verdictBy: "auto" });
    expect(calls).toHaveLength(1);
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
    let captured = false;
    const pool = {
      query: async (_text: string, values: unknown[]) => {
        if (!captured) { params = values; captured = true; } // the upsert call; ignore the follow-up serial UPDATE
        return { rows: [{ id: "cab_1", verdict: "keep", previous_verdict: null, deleted: false }] };
      }
    };
    const dirty: Card = {
      ...card,
      title: "t\u0000itle", summary: "s\u0000ummary", signals: ["a\u0000", "b"], suggested_reason: "r\u0000eason",
      playbook: { kind: "integrate", install: [], repo: null, prompt_text: "p\u0000" }, tags: ["x\u0000"], source_url: "https://a.b/\u0000",
      scenarios: ["coding\u0000"]
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
    expect(params[16]).toEqual(["coding"]);
  });
});
