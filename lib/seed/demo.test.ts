import { describe, expect, it } from "vitest";
import { cardSchema, isValidTag } from "../analysis/card";
import { buildDemoRows, runSeedDemo } from "./demo";

describe("buildDemoRows", () => {
  it("produces 6 captures/runs/capabilities and 3 steps per run", () => {
    const data = buildDemoRows();
    expect(data.captures).toHaveLength(6);
    expect(data.runs).toHaveLength(6);
    expect(data.capabilities).toHaveLength(6);
    expect(data.steps).toHaveLength(18);
  });

  it("uses fixed demo_-prefixed ids, not random ones", () => {
    const data = buildDemoRows();
    for (const c of data.captures) expect(c.id).toMatch(/^demo_cap_\d+$/);
    for (const r of data.runs) expect(r.id).toMatch(/^demo_run_\d+$/);
    for (const cap of data.capabilities) expect(cap.id).toMatch(/^demo_cab_\d+$/);
  });

  it("is deterministic across calls (idempotent inputs)", () => {
    expect(buildDemoRows()).toEqual(buildDemoRows());
  });

  it("every card validates against cardSchema", () => {
    const data = buildDemoRows();
    for (const cap of data.capabilities) expect(() => cardSchema.parse(cap.card)).not.toThrow();
  });

  it("every tag on every card is valid per isValidTag", () => {
    const data = buildDemoRows();
    for (const cap of data.capabilities) for (const tag of cap.card.tags) expect(isValidTag(tag)).toBe(true);
  });

  it("covers all 5 capability types", () => {
    const data = buildDemoRows();
    const types = new Set(data.capabilities.map((c) => c.card.type));
    expect(types).toEqual(new Set(["skill", "experience", "plugin", "prompt", "other"]));
  });

  it("splits verdicts 2 pending / 3 keep / 1 discard", () => {
    const data = buildDemoRows();
    expect(data.capabilities.filter((c) => c.verdict === "pending")).toHaveLength(2);
    expect(data.capabilities.filter((c) => c.verdict === "keep")).toHaveLength(3);
    expect(data.capabilities.filter((c) => c.verdict === "discard")).toHaveLength(1);
  });

  it("pending capabilities have no human verdict_by, keep/discard do", () => {
    const data = buildDemoRows();
    for (const cap of data.capabilities) {
      if (cap.verdict === "pending") expect(cap.verdictBy).toBeNull();
      else expect(cap.verdictBy).toBe("human");
    }
  });

  it("includes exactly one experience playbook, on the experience-type card", () => {
    const data = buildDemoRows();
    const experiencePlaybooks = data.capabilities.filter((c) => c.card.playbook.kind === "experience");
    expect(experiencePlaybooks).toHaveLength(1);
    expect(experiencePlaybooks[0].card.type).toBe("experience");
  });

  it("only uses text and url capture kinds (no images)", () => {
    const data = buildDemoRows();
    for (const c of data.captures) {
      expect(["text", "url"]).toContain(c.kind);
      if (c.kind === "text") { expect(c.text).not.toBeNull(); expect(c.url).toBeNull(); }
      if (c.kind === "url") { expect(c.url).not.toBeNull(); expect(c.text).toBeNull(); }
    }
  });

  it("has unique 64-char hex dedupe keys", () => {
    const data = buildDemoRows();
    const keys = data.captures.map((c) => c.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-f0-9]{64}$/);
  });

  it("has exactly one search step whose output carries 2 sources", () => {
    const data = buildDemoRows();
    const searchSteps = data.steps.filter((s) => s.step === "search");
    expect(searchSteps).toHaveLength(6);
    const withTwoSources = searchSteps.filter((s) => (s.output as { sources: unknown[] }).sources.length === 2);
    expect(withTwoSources).toHaveLength(1);
  });

  it("each run has one vision, one search and one reason step", () => {
    const data = buildDemoRows();
    for (const run of data.runs) {
      const runSteps = data.steps.filter((s) => s.runId === run.id).map((s) => s.step);
      expect(new Set(runSteps)).toEqual(new Set(["vision", "search", "reason"]));
    }
  });
});

describe("runSeedDemo", () => {
  it("refuses to run without SEED_ALLOW=1, without touching the pool", async () => {
    let connected = false;
    const fakePool = { connect: async () => { connected = true; throw new Error("should not connect"); } };
    await expect(runSeedDemo(fakePool as never, {})).rejects.toThrow(/SEED_ALLOW/);
    expect(connected).toBe(false);
  });

  it("also refuses when SEED_ALLOW is set to something other than \"1\"", async () => {
    const fakePool = { connect: async () => { throw new Error("should not connect"); } };
    await expect(runSeedDemo(fakePool as never, { SEED_ALLOW: "true" })).rejects.toThrow(/SEED_ALLOW/);
  });

  it("runs inside BEGIN/COMMIT and returns ids for newly-inserted capabilities", async () => {
    const queries: string[] = [];
    const fakeClient = {
      query: async (text: string) => {
        queries.push(text.trim().split("\n")[0]);
        if (text.includes("INSERT INTO caphub_v2.capabilities")) return { rows: [{ id: "demo_cab_x" }] };
        return { rows: [] };
      },
      release: () => {}
    };
    const fakePool = { connect: async () => fakeClient };
    const ids = await runSeedDemo(fakePool as never, { SEED_ALLOW: "1" });
    expect(queries[0]).toBe("BEGIN");
    expect(queries.at(-1)).toBe("COMMIT");
    expect(ids).toHaveLength(6);
  });

  it("rolls back and rethrows if an insert fails", async () => {
    const queries: string[] = [];
    const fakeClient = {
      query: async (text: string) => {
        queries.push(text.trim().split("\n")[0]);
        if (text.includes("INSERT INTO caphub_v2.captures")) throw new Error("boom");
        return { rows: [] };
      },
      release: () => {}
    };
    const fakePool = { connect: async () => fakeClient };
    await expect(runSeedDemo(fakePool as never, { SEED_ALLOW: "1" })).rejects.toThrow("boom");
    expect(queries.at(-1)).toBe("ROLLBACK");
  });

  it("does not bump tags for pending or discard capabilities, only for newly-inserted keep ones", async () => {
    let bumpCalls = 0;
    const fakeClient = {
      query: async (text: string) => {
        if (text.includes("INSERT INTO caphub_v2.capabilities")) return { rows: [{ id: "demo_cab_x" }] };
        if (text.includes("caphub_v2.tags")) { bumpCalls++; return { rows: [] }; }
        return { rows: [] };
      },
      release: () => {}
    };
    const fakePool = { connect: async () => fakeClient };
    await runSeedDemo(fakePool as never, { SEED_ALLOW: "1" });
    expect(bumpCalls).toBe(3); // one per "keep" capability
  });

  it("does not bump tags when the capability insert is a no-op re-run", async () => {
    let bumpCalls = 0;
    const fakeClient = {
      query: async (text: string) => {
        if (text.includes("caphub_v2.tags")) { bumpCalls++; return { rows: [] }; }
        return { rows: [] }; // every insert reports ON CONFLICT DO NOTHING (already seeded)
      },
      release: () => {}
    };
    const fakePool = { connect: async () => fakeClient };
    const ids = await runSeedDemo(fakePool as never, { SEED_ALLOW: "1" });
    expect(ids).toHaveLength(0);
    expect(bumpCalls).toBe(0);
  });
});
