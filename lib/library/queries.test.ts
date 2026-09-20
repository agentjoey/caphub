import { describe, expect, it } from "vitest";
import { listLibrary, listPending, libraryStats, scenarioStats, getCapabilityDetail, PAGE_SIZE, SEMANTIC_MIN, TO_BUILD_PROGRESS } from "./queries";

function recorder(rows: unknown[][]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let i = 0;
  return { calls, pool: { query: async (text: string, values: unknown[] = []) => { calls.push({ text, values }); return { rows: rows[i++] ?? [] }; } } as never };
}

describe("library queries", () => {
  it("listPending filters pending, not deleted, newest first, paged", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listPending(pool, { page: 2 });
    expect(calls[0].text).toMatch(/cb\.verdict = 'pending'/);
    expect(calls[0].text).toMatch(/cb\.deleted_at IS NULL/);
    expect(calls[0].text).toMatch(/ORDER BY cb\.created_at DESC/);
    expect(calls[0].values).toEqual([PAGE_SIZE, PAGE_SIZE]);
  });
  it("listLibrary defaults to keep and applies search/type/tag/usage filters as parameters", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool, { q: "web scraping", types: ["skill"], tags: ["python"], usage: "integrate", page: 1 });
    const { text, values } = calls[0];
    expect(text).toMatch(/cb\.verdict = 'keep'/);
    expect(text).toMatch(/websearch_to_tsquery\('simple', \$\d+\)/);
    expect(text).toMatch(/cb\.type = ANY\(\$\d+\)/);
    expect(text).toMatch(/cb\.tags @> \$\d+/);
    expect(text).toMatch(/cb\.usage = \$\d+/);
    expect(values).toEqual(expect.arrayContaining(["web scraping", ["skill"], ["python"], "integrate"]));
  });
  it("listLibrary with discarded=true lists discarded instead of kept", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool, { discarded: true, page: 1 });
    expect(calls[0].text).toMatch(/cb\.verdict = 'discard'/);
  });
  it("listLibrary filters by scenarios via array overlap", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool, { scenarios: ["coding", "writing"], page: 1 });
    expect(calls[0].text).toMatch(/cb\.scenarios && \$\d+::text\[\]/);
    expect(calls[0].values).toEqual(expect.arrayContaining([["coding", "writing"]]));
  });
  it("listLibrary filters by progress via ANY, pinned to usage='reference' in SQL so an integrate card (which defaults to progress='todo' with no self-build meaning) can never match a progress filter", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool, { progress: ["todo", "planned"], page: 1 });
    // The usage restriction must be ANDed into the same clause as the progress check (not left to
    // the caller to also pass usage='reference') so every caller — UI, future Telegram — gets the
    // same semantics regardless of whether it separately filters on usage.
    expect(calls[0].text).toMatch(/cb\.usage = 'reference' AND cb\.progress = ANY\(\$\d+\)/);
    expect(calls[0].values).toEqual(expect.arrayContaining([["todo", "planned"]]));
  });
  it("listLibrary with a serial-shaped q returns only that serial, no scoring", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool, { q: "SKL-0012", page: 1 });
    expect(calls[0].text).toMatch(/cb\.serial = \$\d+/);
    expect(calls[0].values).toContain(12);
    expect(calls[0].text).not.toMatch(/embedding/);
    expect(calls[0].text).not.toMatch(/ORDER BY \(/);
    expect(calls[0].text).toMatch(/ORDER BY cb\.created_at DESC/);
  });
  it("listLibrary with a non-serial q builds a scored hybrid query", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool, { q: "web scraping", page: 1 }, { queryEmbedding: [0.1, 0.2], matchedScenarioSlugs: ["data"] });
    const { text, values } = calls[0];
    expect(text).toMatch(/1 - \(cb\.embedding <=> \$\d+::vector\)/);
    expect(text).toMatch(/cb\.scenarios && \$\d+::text\[\]/);
    expect(text).toMatch(/cb\.title ILIKE \$\d+ OR cb\.summary ILIKE \$\d+ OR EXISTS \(SELECT 1 FROM unnest\(cb\.tags\) tg WHERE tg ILIKE \$\d+\)/);
    expect(text).toMatch(/ORDER BY \(COALESCE\(CASE WHEN cb\.embedding IS NOT NULL/);
    expect(text).toMatch(new RegExp(`>= \\$\\d+`));
    expect(values).toEqual(expect.arrayContaining(["[0.1,0.2]", "web scraping", "%web scraping%", ["data"], SEMANTIC_MIN]));
  });
  it("listLibrary's hybrid score adds a small score weight only when cb.score is not null", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool, { q: "web scraping", page: 1 });
    expect(calls[0].text).toMatch(/CASE WHEN cb\.score IS NOT NULL THEN 0\.05 \* \(cb\.score - 3\) ELSE 0 END/);
  });
  it("listLibrary's scored hybrid query tie-breaks on cb.id so equally-scored, equally-updated rows have a stable order", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool, { q: "web scraping", page: 1 }, { queryEmbedding: [0.1, 0.2] });
    expect(calls[0].text).toMatch(/ORDER BY \(COALESCE\(CASE WHEN cb\.embedding IS NOT NULL[\s\S]*DESC, cb\.updated_at DESC, cb\.id\b/);
  });
  it("listLibrary escapes ILIKE metacharacters in q", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool, { q: "100%_done", page: 1 });
    expect(calls[0].values).toContain("%100\\%\\_done%");
  });
  it("listLibrary passes null vector when no query embedding is available", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool, { q: "web scraping", page: 1 });
    expect(calls[0].values).toContain(null);
  });
  it("scenarioStats counts kept cards per scenario slug", async () => {
    const { pool, calls } = recorder([[{ slug: "coding", count: "5" }, { slug: "data", count: "2" }]]);
    const stats = await scenarioStats(pool);
    expect(calls[0].text).toMatch(/unnest\(scenarios\)/);
    expect(calls[0].values).toEqual(["keep"]);
    expect(stats).toEqual([{ slug: "coding", count: 5 }, { slug: "data", count: 2 }]);
  });
  it("scenarioStats respects discarded", async () => {
    const { pool, calls } = recorder([[]]);
    await scenarioStats(pool, { discarded: true });
    expect(calls[0].values).toEqual(["discard"]);
  });
  it("libraryStats counts kept by type, distinct tags of kept, pending, and to-build (reference, todo/planned)", async () => {
    const { pool, calls } = recorder([[{ type: "skill", n: "3" }, { type: "prompt", n: "1" }], [{ n: "7" }], [{ n: "2" }], [{ n: "5" }]]);
    const s = await libraryStats(pool);
    expect(s.byType.skill).toBe(3);
    expect(s.byType.experience).toBe(0);
    expect(s.total).toBe(4);
    expect(s.tagCount).toBe(7);
    expect(s.pending).toBe(2);
    expect(s.toBuild).toBe(5);
    const toBuildCall = calls[3];
    expect(toBuildCall.text).toMatch(/usage = 'reference'/);
    expect(toBuildCall.text).toMatch(/progress = ANY\(\$1\)/);
    expect(toBuildCall.values).toEqual([TO_BUILD_PROGRESS]);
  });
  it("getCapabilityDetail returns null when missing", async () => {
    const { pool } = recorder([[]]);
    expect(await getCapabilityDetail(pool, "cab_x")).toBeNull();
  });
  it("card columns select the capture's thumb_key alongside object_key", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listPending(pool, { page: 1 });
    expect(calls[0].text).toMatch(/'thumbKey', c\.thumb_key/);
  });
  it("getCapabilityDetail joins retention by object_key and returns eligible/purged dates", async () => {
    const { pool, calls } = recorder([
      [{ id: "cab_1", runId: "run_1", capture: { kind: "image", objectKey: "sha256/ab/x", thumbKey: null, text: null, url: null },
        retentionEligibleAt: "2026-10-01T00:00:00.000Z", retentionPurgedAt: "2026-10-02T00:00:00.000Z" }],
      []
    ]);
    const detail = await getCapabilityDetail(pool, "cab_1");
    expect(calls[0].text).toMatch(/LEFT JOIN caphub_v2\.retention ret ON ret\.object_key = c\.object_key/);
    expect(calls[0].text).toMatch(/ret\.eligible_at AS "retentionEligibleAt"/);
    expect(calls[0].text).toMatch(/ret\.purged_at AS "retentionPurgedAt"/);
    expect(detail?.retentionEligibleAt).toBe("2026-10-01T00:00:00.000Z");
    expect(detail?.retentionPurgedAt).toBe("2026-10-02T00:00:00.000Z");
  });
});
