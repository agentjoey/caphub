import { describe, expect, it } from "vitest";
import { listLibrary, listPending, listTodoCapabilities, libraryStats, scenarioStats, allTags, getCapabilityDetail, buildVideoDetail, PAGE_SIZE, SEMANTIC_MIN, TO_BUILD_PROGRESS, TODO_PROGRESS } from "./queries";

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
  it("listTodoCapabilities filters kept, reference-only cards not yet started (todo/planned — building excluded), paged", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listTodoCapabilities(pool, { page: 1 });
    expect(calls[0].text).toMatch(/cb\.verdict = 'keep'/);
    expect(calls[0].text).toMatch(/cb\.deleted_at IS NULL/);
    expect(calls[0].text).toMatch(/cb\.usage = 'reference'/);
    expect(calls[0].text).toMatch(/cb\.progress = ANY\(\$1\)/);
    expect(calls[0].values).toEqual([TODO_PROGRESS, PAGE_SIZE, 0]);
    expect(TODO_PROGRESS).toEqual(["todo", "planned"]);
    // The card's "last run" is its ANALYSIS run — a failed deep dive must not add a
    // 上次分析失败 note to a /todo card (M3.6 fix round 2).
    expect(calls[0].text).toMatch(/WHERE capture_id = cb\.capture_id AND kind = 'analysis'/);
    // A deprecated/superseded reference card must not show up in /todo -- the 待自研 tile
    // (libraryStats' toBuild) is already scoped to status='active', so without this the tile
    // and the Telegram list would disagree (M3.6 final-review fix).
    expect(calls[0].text).toMatch(/cb\.status = 'active'/);
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
  it("listLibrary defaults to status='active' and drops that filter when includeRetired is set", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool, { page: 1 });
    expect(calls[0].text).toMatch(/cb\.status = 'active'/);

    const { pool: pool2, calls: calls2 } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool2, { includeRetired: true, page: 1 });
    expect(calls2[0].text).not.toMatch(/cb\.status = 'active'/);
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
    expect(text).toMatch(/cb\.title ILIKE \$\d+ OR cb\.summary ILIKE \$\d+ OR cb\.summary_points::text ILIKE \$\d+ OR cb\.build_notes::text ILIKE \$\d+ OR EXISTS \(SELECT 1 FROM unnest\(cb\.tags\) tg WHERE tg ILIKE \$\d+\)/);
    expect(text).toMatch(/ORDER BY \(COALESCE\(CASE WHEN cb\.embedding IS NOT NULL/);
    expect(text).toMatch(new RegExp(`>= \\$\\d+`));
    expect(values).toEqual(expect.arrayContaining(["[0.1,0.2]", "web scraping", "%web scraping%", ["data"], SEMANTIC_MIN]));
  });
  it("listLibrary's ILIKE leg covers summary_points, not just title/summary/tags — a card whose only match is inside a point must still surface (M3.8 fix: most prose moved into summary_points, and FTS's `simple` config can't match a CJK substring, so this leg is the only one that can find it)", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool, { q: "仅存在于要点中的词", page: 1 });
    const { text, values } = calls[0];
    const ilikeMatch = text.match(/cb\.title ILIKE \$(\d+) OR cb\.summary ILIKE \$(\d+) OR cb\.summary_points::text ILIKE \$(\d+) OR cb\.build_notes::text ILIKE \$(\d+) OR EXISTS \(SELECT 1 FROM unnest\(cb\.tags\) tg WHERE tg ILIKE \$(\d+)\)/);
    expect(ilikeMatch).not.toBeNull();
    const [, titleIdx, summaryIdx, pointsIdx, notesIdx, tagsIdx] = ilikeMatch!;
    // Same escaped `%q%` parameter as the title/summary/points/tags legs — one ILIKE value, five columns.
    expect(pointsIdx).toBe(titleIdx);
    expect(pointsIdx).toBe(summaryIdx);
    expect(pointsIdx).toBe(notesIdx);
    expect(pointsIdx).toBe(tagsIdx);
    expect(values[Number(pointsIdx) - 1]).toBe("%仅存在于要点中的词%");
    // No ranking change beyond the existing ILIKE-hit weight — a point-only match still scores +0.15, not more.
    expect(text).toMatch(/CASE WHEN \(cb\.title ILIKE \$\d+ OR cb\.summary ILIKE \$\d+ OR cb\.summary_points::text ILIKE \$\d+ OR cb\.build_notes::text ILIKE \$\d+ OR EXISTS \(SELECT 1 FROM unnest\(cb\.tags\) tg WHERE tg ILIKE \$\d+\)\) THEN 0\.15 ELSE 0 END/);
  });
  it("matches a Chinese word that only appears in a build note", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool, { q: "踩坑", page: 1 });
    // simple 配置会把一整串中文切成一个 token，中文搜索实际靠的是 ILIKE 这条腿
    expect(calls[0].text).toMatch(/cb\.build_notes::text ILIKE \$\d+/);
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
  it("scenarioStats is scoped to status='active', like the other facet counts", async () => {
    const { pool, calls } = recorder([[]]);
    await scenarioStats(pool);
    expect(calls[0].text).toMatch(/status = 'active'/);
  });
  it("allTags counts kept, active cards' tags, most-common first", async () => {
    const { pool, calls } = recorder([[{ name: "python", count: "3" }, { name: "cli", count: "1" }]]);
    const tags = await allTags(pool);
    expect(calls[0].text).toMatch(/verdict = 'keep'/);
    expect(calls[0].text).toMatch(/status = 'active'/);
    expect(calls[0].text).toMatch(/unnest\(tags\)/);
    expect(tags).toEqual([{ name: "python", count: 3 }, { name: "cli", count: 1 }]);
  });
  it("libraryStats counts kept by type, distinct tags of kept, pending, and to-build (reference, todo/planned — building excluded)", async () => {
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
    expect(calls[0].text).toMatch(/status = 'active'/);
    expect(calls[1].text).toMatch(/status = 'active'/);
    expect(toBuildCall.text).toMatch(/status = 'active'/);
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
  it("listLibrary narrows to deep-analyzed cards only when the filter is set, and every row says whether it has one", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool, { page: 1 });
    expect(calls[0].text).toMatch(/\(cb\.deep_analysis IS NOT NULL\) AS "hasDeepAnalysis"/);
    expect(calls[0].text).not.toMatch(/WHERE[\s\S]*cb\.deep_analysis IS NOT NULL/);

    const { pool: pool2, calls: calls2 } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool2, { deepAnalyzed: true, page: 1 });
    expect(calls2[0].text).toMatch(/WHERE[\s\S]*cb\.deep_analysis IS NOT NULL/);
    // The count query must carry the same filter, or the pager would disagree with the list.
    expect(calls2[1].text).toMatch(/cb\.deep_analysis IS NOT NULL/);
  });

  it("getCapabilityDetail returns the stored deep analysis plus the latest deep run's state", async () => {
    const analysis = { headline: "好用", sources: [] };
    const { pool, calls } = recorder([
      [{ id: "cab_1", runId: "run_1", capture: { kind: "text", objectKey: null, thumbKey: null, text: "x", url: null },
        deepAnalysis: analysis, deepAnalysisOf: new Date("2026-09-19T00:00:00.000Z"), deepRunState: "failed", deepRunErrorCode: "TIMEOUT" }],
      []
    ]);
    const detail = await getCapabilityDetail(pool, "cab_1");
    expect(calls[0].text).toMatch(/WHERE capture_id = cb\.capture_id AND kind = 'deep'/);
    expect(detail?.deepAnalysis).toEqual(analysis);
    expect(detail?.deepAnalysisOf).toBe("2026-09-19T00:00:00.000Z");
    expect(detail?.deepRunState).toBe("failed");
    expect(detail?.deepRunErrorCode).toBe("TIMEOUT");
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
  it("getCapabilityDetail selects open_questions and enriched_at (M3.7)", async () => {
    const { pool, calls } = recorder([
      [{ id: "cab_1", runId: "run_1", capture: { kind: "text", objectKey: null, thumbKey: null, text: "x", url: null },
        openQuestions: ["是否需要登录"], enrichedAt: new Date("2026-09-20T01:00:00.000Z") }],
      []
    ]);
    const detail = await getCapabilityDetail(pool, "cab_1");
    expect(calls[0].text).toMatch(/cb\.open_questions AS "openQuestions"/);
    expect(calls[0].text).toMatch(/cb\.enriched_at AS "enrichedAt"/);
    expect(detail?.openQuestions).toEqual(["是否需要登录"]);
    expect(detail?.enrichedAt).toBe("2026-09-20T01:00:00.000Z");
  });
  it("getCapabilityDetail resolves supersededBy to a formatted serial via a self-join", async () => {
    const { pool, calls } = recorder([
      [{ id: "cab_1", runId: "run_1", status: "superseded", supersededBy: "cab_2",
        supersededByType: "tool", supersededBySerialNum: 9,
        capture: { kind: "text", objectKey: null, thumbKey: null, text: "x", url: null } }],
      []
    ]);
    const detail = await getCapabilityDetail(pool, "cab_1");
    expect(calls[0].text).toMatch(/LEFT JOIN caphub_v2\.capabilities sup ON sup\.id = cb\.superseded_by/);
    expect(detail?.supersededBySerial).toBe("TOL-0009");
    expect((detail as unknown as Record<string, unknown>).supersededByType).toBeUndefined();
  });
  it("getCapabilityDetail leaves supersededBySerial null when there is no superseded_by target", async () => {
    const { pool } = recorder([
      [{ id: "cab_1", runId: "run_1", status: "active", supersededBy: null,
        capture: { kind: "text", objectKey: null, thumbKey: null, text: "x", url: null } }],
      []
    ]);
    const detail = await getCapabilityDetail(pool, "cab_1");
    expect(detail?.supersededBySerial).toBeNull();
  });

  describe("buildVideoDetail", () => {

  it("carries the video's content points, dropping malformed ones", () => {
    const steps = [
      { step: "fetch", provider: "youtube", ok: true, output: { title: "T", channel: "C", durationSec: 321 } },
      { step: "vision", provider: "gemini", ok: true, output: { content_points: [{ t: "02:15", point: "p1" }, { t: null, point: "p2" }] } }
    ];
    const good = buildVideoDetail("https://youtu.be/C-RdbraCrew", steps as never);
    expect(good!.points).toEqual([{ t: "02:15", point: "p1" }, { t: null, point: "p2" }]);
    const bad = buildVideoDetail("https://youtu.be/C-RdbraCrew", [steps[0], { step: "vision", provider: "gemini", ok: true, output: { content_points: "nope" } }] as never);
    expect(bad!.points).toEqual([]);
    expect(bad!.failed).toBe(false);
  });
    it("returns null when captureUrl is null or empty", () => {
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [];
      expect(buildVideoDetail(null, steps)).toBeNull();
      expect(buildVideoDetail("", steps)).toBeNull();
    });

    it("returns null when URL is not a YouTube URL", () => {
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [];
      expect(buildVideoDetail("https://example.com", steps)).toBeNull();
      expect(buildVideoDetail("https://vimeo.com/123", steps)).toBeNull();
      expect(buildVideoDetail("not-a-url", steps)).toBeNull();
    });

    it("returns null when there is no fetch/youtube step at all (a card analysed before this feature)", () => {
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [
        { step: "search", provider: "tavily", ok: true, output: { sources: [] } },
        { step: "vision", provider: "gemini", ok: true, output: { what: "test", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [], key_moments: [{ t: "1:30", note: "Key point" }] } }
      ];
      expect(buildVideoDetail("https://www.youtube.com/watch?v=dQw4w9WgXcQ", steps)).toBeNull();
    });

    it("returns VideoDetail with null metadata when the fetch/youtube step exists but is not ok", () => {
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [
        { step: "fetch", provider: "youtube", ok: false, output: null },
        { step: "vision", provider: "gemini", ok: true, output: { what: "test", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [], key_moments: [{ t: "1:30", note: "Key point" }] } }
      ];
      const result = buildVideoDetail("https://www.youtube.com/watch?v=dQw4w9WgXcQ", steps);
      expect(result).not.toBeNull();
      expect(result?.videoId).toBe("dQw4w9WgXcQ");
      expect(result?.title).toBeNull();
      expect(result?.channel).toBeNull();
      expect(result?.durationSec).toBeNull();
      expect(result?.clipped).toBe(false);
      expect(result?.failed).toBe(false);
    });

    it("extracts videoId from standard YouTube URL", () => {
      const videoId = "dQw4w9WgXcQ";
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [
        { step: "fetch", provider: "youtube", ok: true, output: { title: "Test", channel: "User", publishedAt: "2026-01-01", durationSec: 180, description: "" } },
        { step: "vision", provider: "gemini", ok: true, output: { what: "test", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [], key_moments: [] } }
      ];
      const result = buildVideoDetail(`https://www.youtube.com/watch?v=${videoId}`, steps);
      expect(result?.videoId).toBe(videoId);
    });

    it("extracts videoId from youtu.be shortlink", () => {
      const videoId = "dQw4w9WgXcQ";
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [
        { step: "fetch", provider: "youtube", ok: true, output: { title: "Test", channel: "User", publishedAt: "2026-01-01", durationSec: 180, description: "" } },
        { step: "vision", provider: "gemini", ok: true, output: { what: "test", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [], key_moments: [] } }
      ];
      const result = buildVideoDetail(`https://youtu.be/${videoId}`, steps);
      expect(result?.videoId).toBe(videoId);
    });

    it("extracts YouTube metadata from last successful fetch/youtube step", () => {
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [
        { step: "fetch", provider: "youtube", ok: false, output: null },
        { step: "fetch", provider: "youtube", ok: true, output: { title: "Old", channel: "OldUser", publishedAt: "2026-01-01", durationSec: 100, description: "old" } },
        { step: "fetch", provider: "youtube", ok: true, output: { title: "New", channel: "NewUser", publishedAt: "2026-02-01", durationSec: 200, description: "new" } },
        { step: "vision", provider: "gemini", ok: true, output: { what: "test", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [], key_moments: [] } }
      ];
      const result = buildVideoDetail("https://www.youtube.com/watch?v=dQw4w9WgXcQ", steps);
      expect(result?.title).toBe("New");
      expect(result?.channel).toBe("NewUser");
      expect(result?.durationSec).toBe(200);
    });

    it("sets clipped=true when durationSec > VIDEO_CLIP_SEC", () => {
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [
        { step: "fetch", provider: "youtube", ok: true, output: { title: "Long", channel: "User", publishedAt: "2026-01-01", durationSec: 6000, description: "" } },
        { step: "vision", provider: "gemini", ok: true, output: { what: "test", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [], key_moments: [] } }
      ];
      const result = buildVideoDetail("https://www.youtube.com/watch?v=dQw4w9WgXcQ", steps);
      expect(result?.clipped).toBe(true);
    });

    it("sets clipped=false when durationSec <= VIDEO_CLIP_SEC", () => {
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [
        { step: "fetch", provider: "youtube", ok: true, output: { title: "Short", channel: "User", publishedAt: "2026-01-01", durationSec: 600, description: "" } },
        { step: "vision", provider: "gemini", ok: true, output: { what: "test", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [], key_moments: [] } }
      ];
      const result = buildVideoDetail("https://www.youtube.com/watch?v=dQw4w9WgXcQ", steps);
      expect(result?.clipped).toBe(false);
    });

    it("sets clipped=false when durationSec is null", () => {
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [
        { step: "fetch", provider: "youtube", ok: true, output: { title: "Unknown", channel: "User", publishedAt: "2026-01-01", durationSec: null, description: "" } },
        { step: "vision", provider: "gemini", ok: true, output: { what: "test", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [], key_moments: [] } }
      ];
      const result = buildVideoDetail("https://www.youtube.com/watch?v=dQw4w9WgXcQ", steps);
      expect(result?.clipped).toBe(false);
    });

    it("sets failed=true when no successful vision/gemini step exists", () => {
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [
        { step: "fetch", provider: "youtube", ok: true, output: { title: "Test", channel: "User", publishedAt: "2026-01-01", durationSec: 180, description: "" } },
        { step: "vision", provider: "gemini", ok: false, output: null }
      ];
      const result = buildVideoDetail("https://www.youtube.com/watch?v=dQw4w9WgXcQ", steps);
      expect(result?.failed).toBe(true);
      expect(result?.moments).toEqual([]);
    });

    it("sets failed=false when successful vision/gemini step exists", () => {
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [
        { step: "fetch", provider: "youtube", ok: true, output: { title: "Test", channel: "User", publishedAt: "2026-01-01", durationSec: 180, description: "" } },
        { step: "vision", provider: "gemini", ok: true, output: { what: "test", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [], key_moments: [{ t: "1:30", note: "Key point" }] } }
      ];
      const result = buildVideoDetail("https://www.youtube.com/watch?v=dQw4w9WgXcQ", steps);
      expect(result?.failed).toBe(false);
    });

    it("extracts key_moments from last successful vision/gemini step", () => {
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [
        { step: "fetch", provider: "youtube", ok: true, output: { title: "Test", channel: "User", publishedAt: "2026-01-01", durationSec: 180, description: "" } },
        { step: "vision", provider: "gemini", ok: true, output: { what: "old", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [], key_moments: [{ t: "0:30", note: "Old" }] } },
        { step: "vision", provider: "gemini", ok: true, output: { what: "new", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [], key_moments: [{ t: "1:30", note: "New" }, { t: "2:00", note: "Another" }] } }
      ];
      const result = buildVideoDetail("https://www.youtube.com/watch?v=dQw4w9WgXcQ", steps);
      expect(result?.moments).toEqual([{ t: "1:30", note: "New" }, { t: "2:00", note: "Another" }]);
    });

    it("returns empty moments array when key_moments is undefined in output", () => {
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [
        { step: "fetch", provider: "youtube", ok: true, output: { title: "Test", channel: "User", publishedAt: "2026-01-01", durationSec: 180, description: "" } },
        { step: "vision", provider: "gemini", ok: true, output: { what: "test", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [] } }
      ];
      const result = buildVideoDetail("https://www.youtube.com/watch?v=dQw4w9WgXcQ", steps);
      expect(result?.moments).toEqual([]);
    });

    it("returns empty moments and failed=false when vision output has invalid key_moments structure", () => {
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [
        { step: "fetch", provider: "youtube", ok: true, output: { title: "Test", channel: "User", publishedAt: "2026-01-01", durationSec: 180, description: "" } },
        { step: "vision", provider: "gemini", ok: true, output: { what: "test", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [], key_moments: "invalid" } }
      ];
      const result = buildVideoDetail("https://www.youtube.com/watch?v=dQw4w9WgXcQ", steps);
      expect(result?.moments).toEqual([]);
      expect(result?.failed).toBe(false);
    });

    it("handles mixed valid and invalid key_moments by validating the array", () => {
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [
        { step: "fetch", provider: "youtube", ok: true, output: { title: "Test", channel: "User", publishedAt: "2026-01-01", durationSec: 180, description: "" } },
        { step: "vision", provider: "gemini", ok: true, output: { what: "test", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [], key_moments: [{ t: "1:30", note: "Valid" }, { t: "invalid", note: "Invalid" }] } }
      ];
      const result = buildVideoDetail("https://www.youtube.com/watch?v=dQw4w9WgXcQ", steps);
      // Invalid structure means moments=[] but extraction still succeeded (failed=false)
      expect(result?.moments).toEqual([]);
      expect(result?.failed).toBe(false);
    });

    it("returns all metadata fields null when fetch step has null/missing fields", () => {
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [
        { step: "fetch", provider: "youtube", ok: true, output: { title: null, channel: null, publishedAt: null, durationSec: null, description: null } },
        { step: "vision", provider: "gemini", ok: true, output: { what: "test", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [], key_moments: [] } }
      ];
      const result = buildVideoDetail("https://www.youtube.com/watch?v=dQw4w9WgXcQ", steps);
      expect(result?.title).toBeNull();
      expect(result?.channel).toBeNull();
      expect(result?.durationSec).toBeNull();
    });

    it("ignores fetch steps with other providers", () => {
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [
        { step: "fetch", provider: "other", ok: true, output: { title: "Other", channel: "Other", publishedAt: "2026-01-01", durationSec: 100, description: "" } },
        { step: "fetch", provider: "youtube", ok: true, output: { title: "YouTube", channel: "YouTube", publishedAt: "2026-01-01", durationSec: 200, description: "" } },
        { step: "vision", provider: "gemini", ok: true, output: { what: "test", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [], key_moments: [] } }
      ];
      const result = buildVideoDetail("https://www.youtube.com/watch?v=dQw4w9WgXcQ", steps);
      expect(result?.title).toBe("YouTube");
    });

    it("ignores vision steps with other providers", () => {
      const steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }> = [
        { step: "fetch", provider: "youtube", ok: true, output: { title: "Test", channel: "User", publishedAt: "2026-01-01", durationSec: 180, description: "" } },
        { step: "vision", provider: "other", ok: true, output: { key_moments: [{ t: "0:30", note: "Other" }] } },
        { step: "vision", provider: "gemini", ok: true, output: { what: "test", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [], key_moments: [{ t: "1:30", note: "Gemini" }] } }
      ];
      const result = buildVideoDetail("https://www.youtube.com/watch?v=dQw4w9WgXcQ", steps);
      expect(result?.moments).toEqual([{ t: "1:30", note: "Gemini" }]);
    });
  });
});
