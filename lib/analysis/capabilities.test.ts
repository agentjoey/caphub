import { describe, expect, it } from "vitest";
import type { Card } from "./card";
import { upsertCapability } from "./capabilities";

const card: Card = {
  title: "t", type: "prompt", summary: "s",
  summary_points: [{ label: "l1", text: "t1" }, { label: "l2", text: "t2" }, { label: "l3", text: "t3" }],
  signals: ["a", "b"], suggested_verdict: "keep", suggested_reason: "r",
  confidence: 0.9, usage: "integrate", playbook: { kind: "integrate", install: [], repo: null }, tags: ["x"], source_url: null,
  scenarios: ["coding"], score: 4, score_reason: "r", source_facts: {}, overlap: { relation: "none", target: null, reason: "" },
  open_questions: [], prompt_locators: []
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
    expect(sql).toContain("RETURNING id, verdict, deleted_at");
    expect(out).toEqual({ id: "cab_1", verdict: "keep", previousVerdict: null, deleted: false });
  });

  it("inserts score, score_reason and source_facts", async () => {
    let sql = "";
    let params: unknown[] = [];
    const pool = {
      query: async (text: string, values: unknown[] = []) => {
        if (sql === "") { sql = text; params = values; }
        return { rows: [{ id: "cab_1", verdict: "keep", previous_verdict: null, deleted: false }] };
      }
    };
    const withFacts: Card = { ...card, score: 4, score_reason: "有仓库", source_facts: { repo_url: "https://github.com/a/b", stars: 10 } };
    await upsertCapability(pool as never, { captureId: "cap_1", runId: "run_1", card: withFacts, verdict: "keep", verdictBy: "auto" });
    expect(sql).toContain("score");
    expect(sql).toContain("score_reason");
    expect(sql).toContain("source_facts");
    expect(params).toContain(4);
    expect(params).toContain("有仓库");
    expect(params).toContain(JSON.stringify({ repo_url: "https://github.com/a/b", stars: 10 }));
  });

  it("a human verdict does not wipe the existing score on re-run", async () => {
    let sql = "";
    const pool = {
      query: async (text: string) => {
        if (sql === "") sql = text;
        return { rows: [{ id: "cab_1", verdict: "keep", previous_verdict: "keep", deleted: false }] };
      }
    };
    await upsertCapability(pool as never, { captureId: "cap_1", runId: "run_2", card, verdict: "keep", verdictBy: "auto" });
    // A human-verdict row keeps its score/score_reason regardless of what this run's card carries,
    // mirroring how verdict/verdict_by/verdict_at are preserved for verdict_by = 'human'.
    expect(sql).toMatch(/score = CASE WHEN caphub_v2\.capabilities\.verdict_by = 'human' THEN caphub_v2\.capabilities\.score ELSE excluded\.score END/);
    expect(sql).toMatch(/score_reason = CASE WHEN caphub_v2\.capabilities\.verdict_by = 'human' THEN caphub_v2\.capabilities\.score_reason ELSE excluded\.score_reason END/);
  });

  it("inserts overlap", async () => {
    let sql = "";
    let params: unknown[] = [];
    const pool = {
      query: async (text: string, values: unknown[] = []) => {
        if (sql === "") { sql = text; params = values; }
        return { rows: [{ id: "cab_1", verdict: "keep", previous_verdict: null, deleted: false }] };
      }
    };
    const overlap: Card["overlap"] = { relation: "duplicate", target: "TOL-0009", reason: "与 TOL-0009 功能重复" };
    await upsertCapability(pool as never, { captureId: "cap_1", runId: "run_1", card: { ...card, overlap }, verdict: "keep", verdictBy: "auto" });
    expect(sql).toContain("overlap");
    expect(params).toContain(JSON.stringify(overlap));
  });

  it("always overwrites overlap on a rerun, unlike verdict/type/score which can be human-pinned", async () => {
    let sql = "";
    const pool = {
      query: async (text: string) => {
        if (sql === "") sql = text;
        return { rows: [{ id: "cab_1", verdict: "keep", previous_verdict: "keep", deleted: false }] };
      }
    };
    await upsertCapability(pool as never, { captureId: "cap_1", runId: "run_2", card, verdict: "keep", verdictBy: "auto" });
    expect(sql).toContain("overlap = excluded.overlap");
    expect(sql).not.toMatch(/overlap = CASE WHEN/);
  });

  it("a human-pinned type is not overwritten by this run's card, mirroring how verdict is preserved", async () => {
    let sql = "";
    const pool = {
      query: async (text: string) => {
        if (sql === "") sql = text;
        return { rows: [{ id: "cab_1", verdict: "keep", previous_verdict: "keep", deleted: false }] };
      }
    };
    await upsertCapability(pool as never, { captureId: "cap_1", runId: "run_2", card, verdict: "keep", verdictBy: "auto" });
    expect(sql).toMatch(/type = CASE WHEN caphub_v2\.capabilities\.type_by = 'human' THEN caphub_v2\.capabilities\.type ELSE excluded\.type END/);
    expect(sql).toMatch(/type_by = CASE WHEN caphub_v2\.capabilities\.type_by = 'human' THEN 'human' ELSE excluded\.type_by END/);
  });

  it("inserts open_questions and overwrites it on rerun", async () => {
    let sql = "";
    let params: unknown[] = [];
    const pool = {
      query: async (text: string, values: unknown[] = []) => {
        if (sql === "") { sql = text; params = values; }
        return { rows: [{ id: "cab_1", verdict: "keep", previous_verdict: null, deleted: false }] };
      }
    };
    const open_questions = ["是否需要登录才能用", "免费额度上限是多少"];
    await upsertCapability(pool as never, { captureId: "cap_1", runId: "run_1", card: { ...card, open_questions }, verdict: "keep", verdictBy: "auto" });
    expect(sql).toContain("open_questions");
    expect(sql).toContain("open_questions = excluded.open_questions");
    expect(params).toContain(JSON.stringify(open_questions));
  });

  it("inserts summary_points and overwrites it on rerun", async () => {
    let sql = "";
    let params: unknown[] = [];
    const pool = {
      query: async (text: string, values: unknown[] = []) => {
        if (sql === "") { sql = text; params = values; }
        return { rows: [{ id: "cab_1", verdict: "keep", previous_verdict: null, deleted: false }] };
      }
    };
    const summary_points: Card["summary_points"] = [
      { label: "定位", text: "一句话定位" }, { label: "适用", text: "适用场景" }, { label: "限制", text: "已知限制" }
    ];
    await upsertCapability(pool as never, { captureId: "cap_1", runId: "run_1", card: { ...card, summary_points }, verdict: "keep", verdictBy: "auto" });
    expect(sql).toContain("summary_points");
    expect(sql).toContain("summary_points = excluded.summary_points");
    expect(params).toContain(JSON.stringify(summary_points));
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
    expect(upsertSql).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$23, \$7, \$8, \$9, \$10, \$11, \$12,[\s\S]*?\n\s*NULL, \$18, \$19, \$20, \$21, \$22, \$24::jsonb, \$25\)/);
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

  it("stores prompts and prompt_unresolved, replacing them on every rerun", async () => {
    let sql = "";
    let params: unknown[] = [];
    const pool = {
      query: async (text: string, values: unknown[] = []) => {
        if (sql === "") { sql = text; params = values; }
        return { rows: [{ id: "cab_1", verdict: "keep", previous_verdict: null, deleted: false }] };
      }
    };
    await upsertCapability(pool as never, {
      captureId: "cap_1", runId: "run_1", card, verdict: "keep", verdictBy: "auto",
      prompts: ["原文一", "原文二"], promptUnresolved: 1
    });
    expect(sql).toContain("prompts = excluded.prompts");
    expect(sql).toContain("prompt_unresolved = excluded.prompt_unresolved");
    expect(params).toContain(JSON.stringify([{ text: "原文一" }, { text: "原文二" }]));
    expect(params).toContain(1);
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
      playbook: { kind: "integrate", install: [], repo: null }, tags: ["x\u0000"], source_url: "https://a.b/\u0000",
      scenarios: ["coding\u0000"], score_reason: "s\u0000core reason", source_facts: { license: "M\u0000IT" },
      overlap: { relation: "duplicate", target: "TOL-0009", reason: "重\u0000复" },
      summary_points: [{ label: "l\u00001", text: "t\u00001" }, { label: "l2", text: "t2" }, { label: "l3", text: "t3" }]
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
    expect(JSON.parse(params[13] as string)).toEqual({ kind: "integrate", install: [], repo: null });
    expect(params[14]).toEqual(["x"]);
    expect(params[15]).toBe("https://a.b/");
    expect(params[16]).toEqual(["coding"]);
    expect(params[18]).toBe("score reason");
    expect(JSON.parse(params[19] as string)).toEqual({ license: "MIT" });
    expect(JSON.parse(params[20] as string)).toEqual({ relation: "duplicate", target: "TOL-0009", reason: "重复" });
    expect(JSON.parse(params[22] as string)).toEqual([
      { label: "l1", text: "t1" }, { label: "l2", text: "t2" }, { label: "l3", text: "t3" }
    ]);
  });
});
