import { describe, expect, it } from "vitest";
import { submitCapture, listRecentCaptures } from "./captures";

function fakePool(existing: { id: string } | null) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      if (text.startsWith("SELECT id FROM caphub_v2.captures")) return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  return { queries, pool: { connect: async () => client } as never };
}

const objects = { putIfAbsent: async () => ({ key: "sha256/ab/" + "a".repeat(64), digest: "a".repeat(64), bytes: 1 }) } as never;

describe("submitCapture", () => {
  it("inserts capture and queued run for new text", async () => {
    const { pool, queries } = fakePool(null);
    const out = await submitCapture({ pool, objects, pipeline: "minimax" }, { source: "web", kind: "text", text: "hi" });
    expect(out.duplicate).toBe(false);
    expect(out.runId).toMatch(/^run_/);
    expect(queries.some((q) => q.text.startsWith("INSERT INTO caphub_v2.captures"))).toBe(true);
    expect(queries.some((q) => q.text.startsWith("INSERT INTO caphub_v2.analysis_runs"))).toBe(true);
  });
  it("returns existing capture on duplicate without enqueuing", async () => {
    const { pool, queries } = fakePool({ id: "cap_existing" });
    const out = await submitCapture({ pool, objects, pipeline: "minimax" }, { source: "web", kind: "text", text: "hi" });
    expect(out).toEqual({ captureId: "cap_existing", runId: null, duplicate: true });
    expect(queries.some((q) => q.text.startsWith("INSERT INTO caphub_v2.analysis_runs"))).toBe(false);
  });
  it("tracks a new image's object for retention", async () => {
    const { pool, queries } = fakePool(null);
    await submitCapture({ pool, objects, pipeline: "minimax" }, { source: "web", kind: "image", bytes: new Uint8Array([1]), mimeType: "image/png" });
    const r = queries.find((q) => q.text.startsWith("INSERT INTO caphub_v2.retention"))!;
    expect(r.values).toEqual(["sha256/ab/" + "a".repeat(64)]);
    expect(r.text).toContain("VALUES ($1, now() + interval '30 days')");
  });
  it("resets a purged retention row when the image is re-uploaded, including as a duplicate", async () => {
    for (const existing of [null, { id: "cap_existing" }]) {
      const { pool, queries } = fakePool(existing);
      await submitCapture({ pool, objects, pipeline: "minimax" }, { source: "web", kind: "image", bytes: new Uint8Array([1]), mimeType: "image/png" });
      const r = queries.find((q) => q.text.startsWith("INSERT INTO caphub_v2.retention"))!;
      expect(r.text).toContain("ON CONFLICT (object_key) DO UPDATE SET purged_at = NULL, error_code = NULL, eligible_at = excluded.eligible_at");
      expect(r.text).toContain("WHERE caphub_v2.retention.purged_at IS NOT NULL");
      const idx = queries.indexOf(r);
      expect(queries.findIndex((q) => q.text === "COMMIT")).toBeGreaterThan(idx);
    }
  });
  it("does not touch retention for text captures", async () => {
    const { pool, queries } = fakePool(null);
    await submitCapture({ pool, objects, pipeline: "minimax" }, { source: "web", kind: "text", text: "hi" });
    expect(queries.some((q) => q.text.includes("caphub_v2.retention"))).toBe(false);
  });
});

describe("listRecentCaptures", () => {
  it("selects capture and capability preview fields", async () => {
    const row = {
      id: "cap_1", kind: "text", createdAt: "2026-09-19T00:00:00.000Z", runState: "done",
      capabilityId: "cab_1", errorCode: null, objectKey: null, text: "hello", url: null,
      title: "Some capability", verdict: "keep", deleted: false
    };
    let queryText = "";
    const pool = { query: async (text: string) => { queryText = text; return { rows: [row] }; } } as never;
    const out = await listRecentCaptures(pool, 20);
    expect(out).toEqual([row]);
    expect(queryText).toContain('c.object_key AS "objectKey"');
    expect(queryText).toContain('left(c.text, 140) AS text');
    expect(queryText).toContain("c.url, cb.title, cb.verdict");
    expect(queryText).toContain('(cb.deleted_at IS NOT NULL) AS deleted');
  });
});
