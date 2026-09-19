import { describe, expect, it } from "vitest";
import { decide, editSuggestion, requestReview, requestRerun, softDelete } from "./actions";

type Handler = (text: string, values: unknown[]) => { rows: unknown[]; rowCount?: number };
function fakePool(handler: Handler) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const releases: unknown[] = [];
  const q = async (text: string, values: unknown[] = []) => { calls.push({ text, values }); const r = handler(text, values); return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length }; };
  return { calls, releases, pool: { query: q, connect: async () => ({ query: q, release: (err?: unknown) => releases.push(err) }) } as never };
}
const T = "2026-09-19T10:00:00.000Z";
const LOCK_CLAUSE = /date_trunc\('milliseconds', cb\.updated_at\) = \$2::timestamptz/;

describe("decide", () => {
  it("updates with optimistic lock and bumps tags on transition into keep", async () => {
    const { pool, calls } = fakePool((t) => t.startsWith("UPDATE caphub_v2.capabilities") ? { rows: [{ updated_at: new Date(T), tags: ["python"], previous: "pending" }] } : { rows: [] });
    const r = await decide(pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "keep" });
    expect(r).toEqual({ ok: true, updatedAt: T });
    const upd = calls.find((c) => c.text.startsWith("UPDATE caphub_v2.capabilities"))!;
    expect(upd.text).toMatch(LOCK_CLAUSE);
    expect(upd.text).toMatch(/verdict_by = 'human'/);
    expect(calls.some((c) => c.text.includes("INSERT INTO caphub_v2.tags"))).toBe(true);
  });
  it("does not bump tags when discarding", async () => {
    const { pool, calls } = fakePool((t) => t.startsWith("UPDATE caphub_v2.capabilities") ? { rows: [{ updated_at: new Date(T), tags: ["python"], previous: "pending" }] } : { rows: [] });
    await decide(pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "discard" });
    expect(calls.some((c) => c.text.includes("INSERT INTO caphub_v2.tags"))).toBe(false);
  });
  it("assigns a serial only when keeping, and never clears an existing one", async () => {
    const { pool, calls } = fakePool((t) => t.startsWith("UPDATE caphub_v2.capabilities") ? { rows: [{ updated_at: new Date(T), tags: ["python"], previous: "pending" }] } : { rows: [] });
    await decide(pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "keep" });
    const upd = calls.find((c) => c.text.startsWith("UPDATE caphub_v2.capabilities"))!;
    expect(upd.text).toMatch(/serial = CASE WHEN \$3 = 'keep' THEN coalesce\(serial, nextval\('caphub_v2\.capability_serial'\)\) ELSE serial END/);
  });
  it("returns CONFLICT when the row changed and NOT_FOUND when missing", async () => {
    const conflict = fakePool((t) => t.startsWith("SELECT 1") ? { rows: [{ "?column?": 1 }] } : { rows: [] });
    expect(await decide(conflict.pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "keep" })).toMatchObject({ ok: false, reason: "CONFLICT", message: "已在别处处理" });
    const missing = fakePool(() => ({ rows: [] }));
    expect(await decide(missing.pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "keep" })).toMatchObject({ ok: false, reason: "NOT_FOUND" });
  });
  it("rejects malformed input without touching the database", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    expect(await decide(pool, { id: "", expectedUpdatedAt: T, verdict: "keep" })).toMatchObject({ ok: false, reason: "INVALID" });
    expect(await decide(pool, { id: "cab_1", expectedUpdatedAt: "not-a-date", verdict: "keep" })).toMatchObject({ ok: false, reason: "INVALID" });
    expect(await decide(pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "maybe" as never })).toMatchObject({ ok: false, reason: "INVALID" });
    expect(calls.length).toBe(0);
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
    expect(upd.text).toMatch(LOCK_CLAUSE);
    expect(upd.text).toMatch(/serial = coalesce\(serial, nextval\('caphub_v2\.capability_serial'\)\)/);
  });
  it("rejects malformed input without touching the database", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    expect(await editSuggestion(pool, { id: "", expectedUpdatedAt: T, type: "skill", usage: "integrate", tags: ["ok"] })).toMatchObject({ ok: false, reason: "INVALID" });
    expect(await editSuggestion(pool, { id: "cab_1", expectedUpdatedAt: "nope", type: "skill", usage: "integrate", tags: ["ok"] })).toMatchObject({ ok: false, reason: "INVALID" });
    expect(await editSuggestion(pool, { id: "cab_1", expectedUpdatedAt: T, type: "skill", usage: "integrate", tags: [1, 2] as never })).toMatchObject({ ok: false, reason: "INVALID" });
    expect(calls.length).toBe(0);
  });
});

describe("softDelete / requestReview / requestRerun", () => {
  it("soft deletes with lock", async () => {
    const { pool, calls } = fakePool((t) => t.startsWith("UPDATE") ? { rows: [{ updated_at: new Date(T) }] } : { rows: [] });
    expect(await softDelete(pool, { id: "cab_1", expectedUpdatedAt: T })).toMatchObject({ ok: true });
    expect(calls[0].text).toMatch(/deleted_at = now\(\)/);
    expect(calls[0].text).toMatch(/date_trunc\('milliseconds', updated_at\) = \$2::timestamptz/);
  });
  it("rejects malformed input without touching the database", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    expect(await softDelete(pool, { id: "cab_1", expectedUpdatedAt: "nope" })).toMatchObject({ ok: false, reason: "INVALID" });
    expect(calls.length).toBe(0);
  });
  it("requestReview does not touch updated_at, returns CONFLICT when already requested and NOT_FOUND when missing", async () => {
    const ok = fakePool(() => ({ rows: [{ id: "cab_1" }] }));
    await requestReview(ok.pool, { id: "cab_1" });
    expect(ok.calls[0].text).not.toMatch(/updated_at/);

    const busy = fakePool((t) => t.startsWith("SELECT 1") ? { rows: [{ "?column?": 1 }] } : { rows: [] });
    expect(await requestReview(busy.pool, { id: "cab_1" })).toMatchObject({ ok: false, reason: "CONFLICT", message: "复核已在进行中" });

    const missing = fakePool(() => ({ rows: [] }));
    expect(await requestReview(missing.pool, { id: "cab_1" })).toMatchObject({ ok: false, reason: "NOT_FOUND" });
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
  it("maps a unique-violation race on insert to CONFLICT", async () => {
    const { pool } = fakePool((t) => {
      if (t.includes("FROM caphub_v2.captures")) return { rows: [{ kind: "text", purged: false, active: false }] };
      if (t.startsWith("INSERT INTO caphub_v2.analysis_runs")) throw Object.assign(new Error("duplicate key"), { code: "23505" });
      return { rows: [] };
    });
    expect(await requestRerun(pool, { captureId: "cap_1", pipeline: "mixed" })).toMatchObject({ ok: false, reason: "CONFLICT", message: "已在排队或分析中" });
  });
  it("rejects a malformed capture id without touching the database", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    expect(await requestRerun(pool, { captureId: "", pipeline: "mixed" })).toMatchObject({ ok: false, reason: "INVALID" });
    expect(calls.length).toBe(0);
  });
});

describe("locale-aware messages", () => {
  it("returns English messages when locale is 'en'", async () => {
    const conflict = fakePool((t) => t.startsWith("SELECT 1") ? { rows: [{ "?column?": 1 }] } : { rows: [] });
    expect(await decide(conflict.pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "keep" }, "en"))
      .toMatchObject({ ok: false, reason: "CONFLICT", message: "Already handled elsewhere" });

    const missing = fakePool(() => ({ rows: [] }));
    expect(await requestReview(missing.pool, { id: "cab_1" }, "en")).toMatchObject({ ok: false, reason: "NOT_FOUND" });

    const busy = fakePool((t) => t.startsWith("SELECT 1") ? { rows: [{ "?column?": 1 }] } : { rows: [] });
    expect(await requestReview(busy.pool, { id: "cab_1" }, "en"))
      .toMatchObject({ ok: false, reason: "CONFLICT", message: "Review already in progress" });

    const { pool } = fakePool(() => ({ rows: [] }));
    const r = await editSuggestion(pool, { id: "cab_1", expectedUpdatedAt: T, type: "skill", usage: "integrate", tags: ["Web Scraping", "爬虫"] }, "en");
    expect(r).toMatchObject({ ok: false, reason: "INVALID", message: "Invalid tags: web scraping, 爬虫 (must be lowercase English, hyphens allowed)" });
  });

  it("still defaults to Chinese messages when no locale is passed", async () => {
    const conflict = fakePool((t) => t.startsWith("SELECT 1") ? { rows: [{ "?column?": 1 }] } : { rows: [] });
    expect(await decide(conflict.pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "keep" }))
      .toMatchObject({ ok: false, reason: "CONFLICT", message: "已在别处处理" });
  });
});

describe("tx() rollback failure", () => {
  it("releases the client with the rollback error instead of returning it to the pool clean", async () => {
    const { pool, releases } = fakePool((t) => {
      if (t.startsWith("UPDATE caphub_v2.capabilities")) throw new Error("boom");
      if (t === "ROLLBACK") throw new Error("rollback failed");
      return { rows: [] };
    });
    await expect(decide(pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "keep" })).rejects.toThrow("boom");
    expect(releases).toHaveLength(1);
    expect(releases[0]).toBeInstanceOf(Error);
    expect((releases[0] as Error).message).toBe("rollback failed");
  });
});
