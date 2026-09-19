import { describe, expect, it } from "vitest";
import { decide, editSuggestion, requestReview, requestRerun, softDelete } from "./actions";

type Handler = (text: string, values: unknown[]) => { rows: unknown[]; rowCount?: number };
function fakePool(handler: Handler) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const q = async (text: string, values: unknown[] = []) => { calls.push({ text, values }); const r = handler(text, values); return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length }; };
  return { calls, pool: { query: q, connect: async () => ({ query: q, release() {} }) } as never };
}
const T = "2026-09-19T10:00:00.000Z";

describe("decide", () => {
  it("updates with optimistic lock and bumps tags on transition into keep", async () => {
    const { pool, calls } = fakePool((t) => t.startsWith("UPDATE caphub_v2.capabilities") ? { rows: [{ updated_at: new Date(T), tags: ["python"], previous: "pending" }] } : { rows: [] });
    const r = await decide(pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "keep" });
    expect(r).toEqual({ ok: true, updatedAt: T });
    const upd = calls.find((c) => c.text.startsWith("UPDATE caphub_v2.capabilities"))!;
    expect(upd.text).toMatch(/updated_at = \$2/);
    expect(upd.text).toMatch(/verdict_by = 'human'/);
    expect(calls.some((c) => c.text.includes("INSERT INTO caphub_v2.tags"))).toBe(true);
  });
  it("does not bump tags when discarding", async () => {
    const { pool, calls } = fakePool((t) => t.startsWith("UPDATE caphub_v2.capabilities") ? { rows: [{ updated_at: new Date(T), tags: ["python"], previous: "pending" }] } : { rows: [] });
    await decide(pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "discard" });
    expect(calls.some((c) => c.text.includes("INSERT INTO caphub_v2.tags"))).toBe(false);
  });
  it("returns CONFLICT when the row changed and NOT_FOUND when missing", async () => {
    const conflict = fakePool((t) => t.startsWith("SELECT 1") ? { rows: [{ "?column?": 1 }] } : { rows: [] });
    expect(await decide(conflict.pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "keep" })).toMatchObject({ ok: false, reason: "CONFLICT", message: "已在别处处理" });
    const missing = fakePool(() => ({ rows: [] }));
    expect(await decide(missing.pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "keep" })).toMatchObject({ ok: false, reason: "NOT_FOUND" });
  });
});

describe("editSuggestion", () => {
  it("rejects invalid tags", async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    const r = await editSuggestion(pool, { id: "cab_1", expectedUpdatedAt: T, type: "skill", usage: "integrate", tags: ["Web Scraping", "爬虫"] });
    expect(r).toMatchObject({ ok: false, reason: "INVALID" });
  });
  it("saves normalised tags and keeps", async () => {
    const { pool, calls } = fakePool((t) => t.startsWith("UPDATE caphub_v2.capabilities") ? { rows: [{ updated_at: new Date(T), tags: ["web-scraping"], previous: "pending" }] } : { rows: [] });
    await editSuggestion(pool, { id: "cab_1", expectedUpdatedAt: T, type: "skill", usage: "integrate", tags: [" Web-Scraping ", "web-scraping"] });
    const upd = calls.find((c) => c.text.startsWith("UPDATE caphub_v2.capabilities"))!;
    expect(upd.values).toContainEqual(["web-scraping"]);
    expect(upd.text).toMatch(/verdict = 'keep'/);
  });
});

describe("softDelete / requestReview / requestRerun", () => {
  it("soft deletes with lock", async () => {
    const { pool, calls } = fakePool((t) => t.startsWith("UPDATE") ? { rows: [{ updated_at: new Date(T) }] } : { rows: [] });
    expect(await softDelete(pool, { id: "cab_1", expectedUpdatedAt: T })).toMatchObject({ ok: true });
    expect(calls[0].text).toMatch(/deleted_at = now\(\)/);
  });
  it("requestReview does not touch updated_at and conflicts when already requested", async () => {
    const ok = fakePool(() => ({ rows: [{ id: "cab_1" }] }));
    await requestReview(ok.pool, { id: "cab_1" });
    expect(ok.calls[0].text).not.toMatch(/updated_at/);
    const busy = fakePool(() => ({ rows: [] }));
    expect(await requestReview(busy.pool, { id: "cab_1" })).toMatchObject({ ok: false, reason: "CONFLICT" });
  });
  it("requestRerun refuses purged images and active runs, else inserts a queued run", async () => {
    const purged = fakePool((t) => t.includes("FROM caphub_v2.captures") ? { rows: [{ kind: "image", purged: true, active: false }] } : { rows: [] });
    expect(await requestRerun(purged.pool, { captureId: "cap_1", pipeline: "mixed" })).toMatchObject({ ok: false, reason: "OBJECT_GONE" });
    const active = fakePool((t) => t.includes("FROM caphub_v2.captures") ? { rows: [{ kind: "text", purged: false, active: true }] } : { rows: [] });
    expect(await requestRerun(active.pool, { captureId: "cap_1", pipeline: "mixed" })).toMatchObject({ ok: false, reason: "CONFLICT" });
    const fresh = fakePool((t) => t.includes("FROM caphub_v2.captures") ? { rows: [{ kind: "text", purged: false, active: false }] } : { rows: [] });
    expect(await requestRerun(fresh.pool, { captureId: "cap_1", pipeline: "mixed" })).toMatchObject({ ok: true });
    expect(fresh.calls.some((c) => c.text.startsWith("INSERT INTO caphub_v2.analysis_runs") && c.values.includes("mixed"))).toBe(true);
  });
});
