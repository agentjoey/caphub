import { describe, expect, it, vi } from "vitest";
import { decide, editSuggestion, ignoreOverlap, requestDeepAnalysis, requestReview, requestRerun, setProgress, setStatus, softDelete, supersedeOverlapTarget } from "./actions";

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
  it("enqueues an M3.7 enrich run, after commit, when deciding keep on a never-enriched card", async () => {
    const { pool, calls } = fakePool((t) => t.startsWith("UPDATE caphub_v2.capabilities")
      ? { rows: [{ updated_at: new Date(T), tags: ["python"], previous: "pending", capture_id: "cap_1", enriched_at: null, pipeline: "mixed" }] }
      : { rows: [] });
    const r = await decide(pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "keep" });
    expect(r).toMatchObject({ ok: true });
    const enqueue = calls.find((c) => c.text.includes("INSERT INTO caphub_v2.analysis_runs"));
    expect(enqueue).toBeDefined();
    expect(enqueue!.text).toContain("'enrich'");
    expect(enqueue!.values).toEqual([expect.any(String), "cap_1", "mixed"]);
  });
  it("does not enqueue an enrich run when discarding, or when the card is already enriched", async () => {
    const { pool: discardPool, calls: discardCalls } = fakePool((t) => t.startsWith("UPDATE caphub_v2.capabilities")
      ? { rows: [{ updated_at: new Date(T), tags: [], previous: "keep", capture_id: "cap_1", enriched_at: null, pipeline: "mixed" }] }
      : { rows: [] });
    await decide(discardPool, { id: "cab_1", expectedUpdatedAt: T, verdict: "discard" });
    expect(discardCalls.some((c) => c.text.includes("INSERT INTO caphub_v2.analysis_runs"))).toBe(false);

    const { pool: enrichedPool, calls: enrichedCalls } = fakePool((t) => t.startsWith("UPDATE caphub_v2.capabilities")
      ? { rows: [{ updated_at: new Date(T), tags: [], previous: "pending", capture_id: "cap_1", enriched_at: "2026-09-01T00:00:00.000Z", pipeline: "mixed" }] }
      : { rows: [] });
    await decide(enrichedPool, { id: "cab_1", expectedUpdatedAt: T, verdict: "keep" });
    expect(enrichedCalls.some((c) => c.text.includes("INSERT INTO caphub_v2.analysis_runs"))).toBe(false);
  });
  it("still resolves ok when the (already-committed) enrich enqueue fails for a reason other than a duplicate", async () => {
    // decide()'s own verdict write already committed by the time the enqueue runs -- a
    // non-23505 enqueue failure (pool exhaustion, connection drop) must never make decide()
    // reject an edit that in fact succeeded (the caller would see a false failure, and a retry
    // would then hit a stale expectedUpdatedAt conflict).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { pool } = fakePool((t) => {
        if (t.startsWith("UPDATE caphub_v2.capabilities")) return { rows: [{ updated_at: new Date(T), tags: ["python"], previous: "pending", capture_id: "cap_1", enriched_at: null, pipeline: "mixed" }] };
        if (t.includes("INSERT INTO caphub_v2.analysis_runs")) throw new Error("connection reset");
        return { rows: [] };
      });
      const r = await decide(pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "keep" });
      expect(r).toMatchObject({ ok: true });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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
    expect(upd.text).toMatch(/type_by = 'human'/);
    expect(upd.text).toMatch(/suggestion_by = 'human'/);
    expect(upd.text).toMatch(LOCK_CLAUSE);
    expect(upd.text).toMatch(/serial = coalesce\(serial, nextval\('caphub_v2\.capability_serial'\)\)/);
  });
  it("enqueues an M3.7 enrich run, after commit, when the card has never been enriched", async () => {
    const { pool, calls } = fakePool((t) => t.startsWith("UPDATE caphub_v2.capabilities")
      ? { rows: [{ updated_at: new Date(T), tags: ["web-scraping"], previous: "pending", capture_id: "cap_2", enriched_at: null, pipeline: "minimax" }] }
      : { rows: [] });
    await editSuggestion(pool, { id: "cab_1", expectedUpdatedAt: T, type: "skill", usage: "integrate", tags: ["web-scraping"] });
    const enqueue = calls.find((c) => c.text.includes("INSERT INTO caphub_v2.analysis_runs"));
    expect(enqueue).toBeDefined();
    expect(enqueue!.values).toEqual([expect.any(String), "cap_2", "minimax"]);
  });
  it("does not enqueue an enrich run via editSuggestion when the card was already enriched", async () => {
    const { pool, calls } = fakePool((t) => t.startsWith("UPDATE caphub_v2.capabilities")
      ? { rows: [{ updated_at: new Date(T), tags: ["web-scraping"], previous: "keep", capture_id: "cap_2", enriched_at: "2026-09-01T00:00:00.000Z", pipeline: "minimax" }] }
      : { rows: [] });
    await editSuggestion(pool, { id: "cab_1", expectedUpdatedAt: T, type: "skill", usage: "integrate", tags: ["web-scraping"] });
    expect(calls.some((c) => c.text.includes("INSERT INTO caphub_v2.analysis_runs"))).toBe(false);
  });
  it("still resolves ok when the (already-committed) enrich enqueue fails for a reason other than a duplicate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { pool } = fakePool((t) => {
        if (t.startsWith("UPDATE caphub_v2.capabilities")) return { rows: [{ updated_at: new Date(T), tags: ["web-scraping"], previous: "pending", capture_id: "cap_2", enriched_at: null, pipeline: "minimax" }] };
        if (t.includes("INSERT INTO caphub_v2.analysis_runs")) throw new Error("connection reset");
        return { rows: [] };
      });
      const r = await editSuggestion(pool, { id: "cab_1", expectedUpdatedAt: T, type: "skill", usage: "integrate", tags: ["web-scraping"] });
      expect(r).toMatchObject({ ok: true });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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

  /**
   * Evaluates the capture pre-check against a seeded `analysis_runs` table by applying the
   * query's OWN kind predicate — so dropping `r.kind = 'analysis'` from the SQL fails these
   * tests, instead of them passing on a hand-fed `active` boolean.
   */
  function rerunPool(runs: Array<{ kind: string; state: string }>) {
    return fakePool((t) => {
      if (t.includes("FROM caphub_v2.captures")) {
        const scopedToAnalysis = /r\.kind = 'analysis'/.test(t);
        const active = runs.some((r) => ["queued", "running"].includes(r.state) && (!scopedToAnalysis || r.kind === "analysis"));
        return { rows: [{ kind: "text", purged: false, active }] };
      }
      return { rows: [] };
    });
  }

  // Regression (M3.6 fix round 3): migration 010 scoped analysis_runs_one_active — the real DB
  // guard — to kind = 'analysis'. An unscoped pre-check here would be stricter than the database,
  // refusing a 重跑分析 that the insert would have accepted, just because a deep dive is running.
  it("queues a rerun while a deep run is queued or running, since only an active ANALYSIS run blocks one", async () => {
    for (const state of ["queued", "running"]) {
      const { pool, calls } = rerunPool([{ kind: "deep", state }]);
      expect(await requestRerun(pool, { captureId: "cap_1", pipeline: "mixed" })).toMatchObject({ ok: true });
      expect(calls.some((c) => c.text.startsWith("INSERT INTO caphub_v2.analysis_runs"))).toBe(true);
    }
  });

  it("still refuses a rerun while an analysis run of the same capture is queued or running", async () => {
    for (const state of ["queued", "running"]) {
      const { pool, calls } = rerunPool([{ kind: "analysis", state }]);
      expect(await requestRerun(pool, { captureId: "cap_1", pipeline: "mixed" }))
        .toMatchObject({ ok: false, reason: "CONFLICT", message: "已在排队或分析中" });
      expect(calls.some((c) => c.text.startsWith("INSERT INTO caphub_v2.analysis_runs"))).toBe(false);
    }
  });

  it("ignores a finished deep run entirely", async () => {
    const { pool } = rerunPool([{ kind: "deep", state: "failed" }, { kind: "analysis", state: "done" }]);
    expect(await requestRerun(pool, { captureId: "cap_1", pipeline: "mixed" })).toMatchObject({ ok: true });
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

describe("setProgress", () => {
  const ok = (t: string) => t.startsWith("UPDATE caphub_v2.capabilities")
    ? { rows: [{ updated_at: new Date(T) }] }
    : { rows: [] };

  it("writes progress, link and progress_at under the same optimistic lock, bumping updated_at", async () => {
    const { pool, calls } = fakePool(ok);
    const r = await setProgress(pool, { id: "cab_1", expectedUpdatedAt: T, progress: "building", link: "https://github.com/joey/thing" });
    expect(r).toEqual({ ok: true, updatedAt: T });
    const upd = calls.find((c) => c.text.startsWith("UPDATE caphub_v2.capabilities"))!;
    expect(upd.text).toMatch(/progress = \$3/);
    expect(upd.text).toMatch(/progress_link = \$4/);
    expect(upd.text).toMatch(/progress_at = now\(\)/);
    expect(upd.text).toMatch(/updated_at = now\(\)/);
    expect(upd.text).toMatch(/date_trunc\('milliseconds', updated_at\) = \$2::timestamptz/);
    expect(upd.text).toMatch(/usage = 'reference'/);
    expect(upd.text).toMatch(/verdict = 'keep'/);
    // SET touches only progress/progress_link/progress_at/updated_at — `verdict` only appears
    // in the WHERE guard, never assigned.
    const setClause = upd.text.slice(upd.text.indexOf("SET"), upd.text.indexOf("WHERE"));
    expect(setClause).not.toMatch(/verdict\s*=/);
    expect(upd.values).toEqual(["cab_1", T, "building", "https://github.com/joey/thing"]);
  });

  it("stores an empty or blank link as NULL", async () => {
    for (const link of ["", "   ", null, undefined]) {
      const { pool, calls } = fakePool(ok);
      expect(await setProgress(pool, { id: "cab_1", expectedUpdatedAt: T, progress: "done", link })).toMatchObject({ ok: true });
      expect(calls[0].values[3]).toBe(null);
    }
  });

  it("rejects a malformed link and a bad progress value without touching the database", async () => {
    const { pool, calls } = fakePool(ok);
    expect(await setProgress(pool, { id: "cab_1", expectedUpdatedAt: T, progress: "todo", link: "javascript:alert(1)" }))
      .toMatchObject({ ok: false, reason: "INVALID" });
    expect(await setProgress(pool, { id: "cab_1", expectedUpdatedAt: T, progress: "todo", link: "not a url" }))
      .toMatchObject({ ok: false, reason: "INVALID" });
    expect(await setProgress(pool, { id: "cab_1", expectedUpdatedAt: T, progress: "shipped" as never }))
      .toMatchObject({ ok: false, reason: "INVALID" });
    expect(await setProgress(pool, { id: "", expectedUpdatedAt: T, progress: "todo" })).toMatchObject({ ok: false, reason: "INVALID" });
    expect(await setProgress(pool, { id: "cab_1", expectedUpdatedAt: "nope", progress: "todo" })).toMatchObject({ ok: false, reason: "INVALID" });
    expect(calls.length).toBe(0);
  });

  it("strips NUL from the link before binding it", async () => {
    const { pool, calls } = fakePool(ok);
    await setProgress(pool, { id: "cab_1", expectedUpdatedAt: T, progress: "planned", link: "https://ex.com/a\u0000b" });
    expect(String(calls[0].values[3])).not.toMatch(/\u0000/);
  });

  it("returns CONFLICT when the row moved on, NOT_FOUND when it is gone", async () => {
    const conflict = fakePool((t) => t.startsWith("SELECT usage") ? { rows: [{ usage: "reference", verdict: "keep" }] }
      : t.startsWith("SELECT 1") ? { rows: [{ "?column?": 1 }] } : { rows: [] });
    expect(await setProgress(conflict.pool, { id: "cab_1", expectedUpdatedAt: T, progress: "done" }))
      .toMatchObject({ ok: false, reason: "CONFLICT", message: "已在别处处理" });

    const missing = fakePool(() => ({ rows: [] }));
    expect(await setProgress(missing.pool, { id: "cab_1", expectedUpdatedAt: T, progress: "done" }))
      .toMatchObject({ ok: false, reason: "NOT_FOUND" });
  });

  it("refuses an integrate card instead of reporting a phantom conflict", async () => {
    const { pool } = fakePool((t) => t.startsWith("SELECT usage") ? { rows: [{ usage: "integrate", verdict: "keep" }] } : { rows: [] });
    expect(await setProgress(pool, { id: "cab_1", expectedUpdatedAt: T, progress: "done" }))
      .toMatchObject({ ok: false, reason: "INVALID", message: "只有参考自研的卡片可以记录进度" });
  });

  // Regression: a discarded reference card must not be able to sit at 'building'/'done'/etc — a
  // discard should retire it from self-build tracking. The WHERE guard's AND verdict = 'keep'
  // makes the UPDATE miss, and this ambiguity-resolution path must report it as INVALID (a
  // deliberate refusal), not CONFLICT (which would suggest retrying after a reload helps).
  it("refuses a discarded reference card instead of reporting a phantom conflict", async () => {
    const { pool, calls } = fakePool((t) => t.startsWith("SELECT usage") ? { rows: [{ usage: "reference", verdict: "discard" }] } : { rows: [] });
    expect(await setProgress(pool, { id: "cab_1", expectedUpdatedAt: T, progress: "building" }))
      .toMatchObject({ ok: false, reason: "INVALID", message: "只有已保留的卡片可以记录进度" });
    expect(calls.some((c) => c.text.startsWith("UPDATE caphub_v2.capabilities SET progress"))).toBe(true);
  });

  it("speaks English when asked", async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    expect(await setProgress(pool, { id: "cab_1", expectedUpdatedAt: T, progress: "todo", link: "ftp://x" }, "en"))
      .toMatchObject({ ok: false, reason: "INVALID", message: "Link must start with http:// or https://" });
  });
});

describe("setStatus", () => {
  it("rejects malformed input without touching the database", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    expect(await setStatus(pool, { id: "", expectedUpdatedAt: T, status: "active" })).toMatchObject({ ok: false, reason: "INVALID" });
    expect(await setStatus(pool, { id: "cab_1", expectedUpdatedAt: "nope", status: "active" })).toMatchObject({ ok: false, reason: "INVALID" });
    expect(await setStatus(pool, { id: "cab_1", expectedUpdatedAt: T, status: "bogus" as never })).toMatchObject({ ok: false, reason: "INVALID" });
    expect(calls.length).toBe(0);
  });

  it("rejects supersededBy unless status is 'superseded'", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    expect(await setStatus(pool, { id: "cab_1", expectedUpdatedAt: T, status: "active", supersededBy: "TOL-0009" }))
      .toMatchObject({ ok: false, reason: "INVALID", message: "只有标记被替代时才能填写对方卡片编号" });
    expect(await setStatus(pool, { id: "cab_1", expectedUpdatedAt: T, status: "deprecated", supersededBy: "TOL-0009" }))
      .toMatchObject({ ok: false, reason: "INVALID" });
    expect(calls.length).toBe(0);
  });

  it("requires supersededBy when status is 'superseded'", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    expect(await setStatus(pool, { id: "cab_1", expectedUpdatedAt: T, status: "superseded" }))
      .toMatchObject({ ok: false, reason: "INVALID", message: "标记被替代需要填写对方卡片编号" });
    expect(calls.length).toBe(0);
  });

  it("resolves a serial-code supersededBy to the target's id before writing", async () => {
    const { pool, calls } = fakePool((t) =>
      t.startsWith("SELECT id FROM caphub_v2.capabilities WHERE serial") ? { rows: [{ id: "cab_2" }] }
      : t.startsWith("UPDATE caphub_v2.capabilities") ? { rows: [{ updated_at: new Date(T) }] }
      : { rows: [] });
    const r = await setStatus(pool, { id: "cab_1", expectedUpdatedAt: T, status: "superseded", supersededBy: "TOL-0009" });
    expect(r).toEqual({ ok: true, updatedAt: T });
    const upd = calls.find((c) => c.text.startsWith("UPDATE caphub_v2.capabilities"))!;
    expect(upd.values).toEqual(["cab_1", T, "superseded", "cab_2", null]);
    expect(upd.text).toMatch(/date_trunc\('milliseconds', updated_at\) = \$2::timestamptz/);
  });

  it("rejects an unresolvable serial", async () => {
    const { pool } = fakePool((t) => t.startsWith("SELECT id FROM caphub_v2.capabilities WHERE serial") ? { rows: [] } : { rows: [] });
    expect(await setStatus(pool, { id: "cab_1", expectedUpdatedAt: T, status: "superseded", supersededBy: "TOL-9999" }))
      .toMatchObject({ ok: false, reason: "INVALID", message: "找不到对应编号的卡片" });
  });

  it("rejects a self-reference", async () => {
    const { pool } = fakePool((t) => t.startsWith("SELECT id FROM caphub_v2.capabilities WHERE serial") ? { rows: [{ id: "cab_1" }] } : { rows: [] });
    expect(await setStatus(pool, { id: "cab_1", expectedUpdatedAt: T, status: "superseded", supersededBy: "TOL-0001" }))
      .toMatchObject({ ok: false, reason: "INVALID", message: "不能设置为被自己替代" });
  });

  it("writes a null superseded_by and status_note for a plain deprecate/restore", async () => {
    const { pool, calls } = fakePool((t) => t.startsWith("UPDATE caphub_v2.capabilities") ? { rows: [{ updated_at: new Date(T) }] } : { rows: [] });
    await setStatus(pool, { id: "cab_1", expectedUpdatedAt: T, status: "deprecated", note: " 已被更好的方案取代 " });
    const upd = calls.find((c) => c.text.startsWith("UPDATE caphub_v2.capabilities"))!;
    expect(upd.values).toEqual(["cab_1", T, "deprecated", null, "已被更好的方案取代"]);
  });

  it("returns CONFLICT when the row changed and NOT_FOUND when missing", async () => {
    const conflict = fakePool((t) => t.startsWith("SELECT 1") ? { rows: [{ "?column?": 1 }] } : { rows: [] });
    expect(await setStatus(conflict.pool, { id: "cab_1", expectedUpdatedAt: T, status: "active" })).toMatchObject({ ok: false, reason: "CONFLICT" });
    const missing = fakePool(() => ({ rows: [] }));
    expect(await setStatus(missing.pool, { id: "cab_1", expectedUpdatedAt: T, status: "active" })).toMatchObject({ ok: false, reason: "NOT_FOUND" });
  });
});

describe("ignoreOverlap", () => {
  it("rejects malformed input without touching the database", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    expect(await ignoreOverlap(pool, { id: "", expectedUpdatedAt: T })).toMatchObject({ ok: false, reason: "INVALID" });
    expect(calls.length).toBe(0);
  });

  it("clears this card's overlap with its own optimistic lock", async () => {
    const { pool, calls } = fakePool((t) => t.startsWith("UPDATE") ? { rows: [{ updated_at: new Date(T) }] } : { rows: [] });
    expect(await ignoreOverlap(pool, { id: "cab_1", expectedUpdatedAt: T })).toEqual({ ok: true, updatedAt: T });
    expect(calls[0].text).toMatch(/overlap = '\{"relation":"none","target":null,"reason":""\}'::jsonb/);
    expect(calls[0].text).toMatch(/date_trunc\('milliseconds', updated_at\) = \$2::timestamptz/);
  });

  it("returns CONFLICT when the row moved on", async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    expect(await ignoreOverlap(pool, { id: "cab_1", expectedUpdatedAt: T })).toMatchObject({ ok: false });
  });
});

describe("supersedeOverlapTarget", () => {
  it("rejects malformed input without touching the database", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    expect(await supersedeOverlapTarget(pool, { id: "" })).toMatchObject({ ok: false, reason: "INVALID" });
    expect(calls.length).toBe(0);
  });

  it("marks the other card superseded by this one, and clears this card's own overlap relation in the same transaction", async () => {
    const { pool, calls } = fakePool((t) =>
      t.startsWith("SELECT overlap") ? { rows: [{ overlap: { relation: "duplicate", target: "TOL-0009", reason: "same tool" } }] }
      : t.startsWith("SELECT id, status FROM caphub_v2.capabilities WHERE serial") ? { rows: [{ id: "cab_2", status: "active" }] }
      : t.startsWith("UPDATE caphub_v2.capabilities SET status = 'superseded'") ? { rows: [{ updated_at: new Date(T) }] }
      : t.startsWith("UPDATE caphub_v2.capabilities SET overlap") ? { rows: [] }
      : { rows: [] });
    const r = await supersedeOverlapTarget(pool, { id: "cab_1" });
    expect(r).toEqual({ ok: true, updatedAt: T });
    const statusUpd = calls.find((c) => c.text.startsWith("UPDATE caphub_v2.capabilities SET status = 'superseded'"))!;
    expect(statusUpd.values).toEqual(["cab_2", "cab_1", "same tool"]);
    expect(calls.some((c) => c.text.includes("FOR UPDATE"))).toBe(true);
    const overlapUpd = calls.find((c) => c.text.startsWith("UPDATE caphub_v2.capabilities SET overlap"))!;
    expect(overlapUpd.text).toMatch(/jsonb_set\(overlap, '\{relation\}', '"none"'\)/);
    expect(overlapUpd.values).toEqual(["cab_1"]);
    // Both writes must happen inside the same tx() (BEGIN..COMMIT), never as two independent pool calls.
    expect(calls[0].text).toBe("BEGIN");
    expect(calls[calls.length - 1].text).toBe("COMMIT");
  });

  it("leaves this card's overlap untouched (and does not clear it) when the other card's status write fails", async () => {
    const { pool, calls } = fakePool((t) =>
      t.startsWith("SELECT overlap") ? { rows: [{ overlap: { relation: "duplicate", target: "TOL-0009", reason: "same tool" } }] }
      : t.startsWith("SELECT id, status FROM caphub_v2.capabilities WHERE serial") ? { rows: [{ id: "cab_2", status: "active" }] }
      : t.startsWith("UPDATE caphub_v2.capabilities SET status = 'superseded'") ? { rows: [] } // simulates the write failing/conflicting
      : t.startsWith("SELECT 1") ? { rows: [{ "?column?": 1 }] } // missingOrConflict's probe finds the target row still there
      : { rows: [] });
    const r = await supersedeOverlapTarget(pool, { id: "cab_1" });
    expect(r).toMatchObject({ ok: false, reason: "CONFLICT" });
    expect(calls.some((c) => c.text.startsWith("UPDATE caphub_v2.capabilities SET overlap"))).toBe(false);
  });

  it("rejects a source card with no overlap finding", async () => {
    const { pool } = fakePool((t) => t.startsWith("SELECT overlap") ? { rows: [{ overlap: { relation: "none", target: null, reason: "" } }] } : { rows: [] });
    expect(await supersedeOverlapTarget(pool, { id: "cab_1" })).toMatchObject({ ok: false, reason: "INVALID", message: "没有可处理的比对结果" });
  });

  it("returns NOT_FOUND when the source card is gone", async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    expect(await supersedeOverlapTarget(pool, { id: "cab_1" })).toMatchObject({ ok: false, reason: "NOT_FOUND" });
  });

  it("rejects when the target serial cannot be resolved", async () => {
    const { pool } = fakePool((t) =>
      t.startsWith("SELECT overlap") ? { rows: [{ overlap: { relation: "duplicate", target: "TOL-0009", reason: "x" } }] }
      : t.startsWith("SELECT id, status FROM caphub_v2.capabilities WHERE serial") ? { rows: [] }
      : { rows: [] });
    expect(await supersedeOverlapTarget(pool, { id: "cab_1" })).toMatchObject({ ok: false, reason: "INVALID", message: "找不到对应编号的卡片" });
  });

  it("returns a CONFLICT-style result without writing anything when the target is already deprecated/superseded", async () => {
    const { pool, calls } = fakePool((t) =>
      t.startsWith("SELECT overlap") ? { rows: [{ overlap: { relation: "duplicate", target: "TOL-0009", reason: "same tool" } }] }
      : t.startsWith("SELECT id, status FROM caphub_v2.capabilities WHERE serial") ? { rows: [{ id: "cab_2", status: "deprecated" }] }
      : { rows: [] });
    const r = await supersedeOverlapTarget(pool, { id: "cab_1" });
    expect(r).toMatchObject({ ok: false, reason: "CONFLICT", message: "对方卡片已被标记为失效或替代，无需重复处理" });
    expect(calls.some((c) => c.text.startsWith("UPDATE caphub_v2.capabilities SET status = 'superseded'"))).toBe(false);
    expect(calls.some((c) => c.text.startsWith("UPDATE caphub_v2.capabilities SET overlap"))).toBe(false);
  });

  it("also treats an already-superseded target as a conflict, not a silent overwrite", async () => {
    const { pool } = fakePool((t) =>
      t.startsWith("SELECT overlap") ? { rows: [{ overlap: { relation: "duplicate", target: "TOL-0009", reason: "same tool" } }] }
      : t.startsWith("SELECT id, status FROM caphub_v2.capabilities WHERE serial") ? { rows: [{ id: "cab_2", status: "superseded" }] }
      : { rows: [] });
    expect(await supersedeOverlapTarget(pool, { id: "cab_1" })).toMatchObject({ ok: false, reason: "CONFLICT" });
  });
});

describe("requestDeepAnalysis", () => {
  const deepPool = (row: { verdict: string; pipeline: string; active: boolean } | null, opts: { insertThrows?: unknown } = {}) =>
    fakePool((t) => {
      if (t.startsWith("SELECT cb.verdict")) return { rows: row ? [row] : [] };
      if (t.startsWith("INSERT INTO caphub_v2.analysis_runs")) {
        if (opts.insertThrows) throw opts.insertThrows;
        return { rows: [] };
      }
      return { rows: [] };
    });

  it("queues a kind='deep' run reusing the card's own run pipeline", async () => {
    const { pool, calls } = deepPool({ verdict: "keep", pipeline: "mixed", active: false });
    const r = await requestDeepAnalysis(pool, { captureId: "cap_1" });
    expect(r.ok).toBe(true);
    const insert = calls.find((c) => c.text.startsWith("INSERT INTO caphub_v2.analysis_runs"))!;
    expect(insert.text).toMatch(/'queued', 'deep'/);
    expect(insert.values.slice(1)).toEqual(["cap_1", "mixed"]);
  });

  it("refuses a card that is not kept, and one that does not exist", async () => {
    const pending = deepPool({ verdict: "pending", pipeline: "mixed", active: false });
    expect(await requestDeepAnalysis(pending.pool, { captureId: "cap_1" })).toMatchObject({ ok: false, reason: "INVALID", message: "只有已保留的卡片可以深度分析" });
    expect(pending.calls.some((c) => c.text.startsWith("INSERT"))).toBe(false);

    const discarded = deepPool({ verdict: "discard", pipeline: "mixed", active: false });
    expect(await requestDeepAnalysis(discarded.pool, { captureId: "cap_1" })).toMatchObject({ ok: false, reason: "INVALID" });

    // The lookup itself is scoped to `deleted_at IS NULL`, so a deleted card reads as missing.
    const missing = deepPool(null);
    expect(await requestDeepAnalysis(missing.pool, { captureId: "cap_1" })).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    expect(missing.calls[0].text).toMatch(/cb\.deleted_at IS NULL/);
    expect(missing.calls[0].text).toMatch(/d\.kind = 'deep' AND d\.state IN \('queued','running'\)/);
  });

  it("returns CONFLICT for an already active deep run, both from the pre-check and from the unique index", async () => {
    const precheck = deepPool({ verdict: "keep", pipeline: "mixed", active: true });
    expect(await requestDeepAnalysis(precheck.pool, { captureId: "cap_1" })).toMatchObject({ ok: false, reason: "CONFLICT", message: "深度分析已在排队或进行中" });
    expect(precheck.calls.some((c) => c.text.startsWith("INSERT"))).toBe(false);

    // A concurrent request that wins the pre-check race is caught by analysis_runs_one_active_deep.
    const raced = deepPool({ verdict: "keep", pipeline: "mixed", active: false }, { insertThrows: Object.assign(new Error("dup"), { code: "23505" }) });
    expect(await requestDeepAnalysis(raced.pool, { captureId: "cap_1" })).toMatchObject({ ok: false, reason: "CONFLICT" });
  });

  it("rejects malformed input without touching the database", async () => {
    const { pool, calls } = deepPool(null);
    expect(await requestDeepAnalysis(pool, { captureId: "" })).toMatchObject({ ok: false, reason: "INVALID" });
    expect(calls.length).toBe(0);
  });
});
