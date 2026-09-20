import { describe, expect, it, vi } from "vitest";
import type { CapabilityDetail } from "../library/queries";
import { getCapability, getStats, listRecent, listToBuild, MAX_ITEMS, resolveSerial, searchCapabilities } from "./tools";

const fakePool = (rows: unknown[]) => ({ query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) });

/** A full CapabilityDetail row, camelCased as `getCapabilityDetail`'s SELECT returns it. */
function detailRow(overrides: Partial<CapabilityDetail> = {}) {
  return {
    id: "cap_1", captureId: "cpt_1", runId: "run_1", runPipeline: "p", runState: "done",
    title: "GSAP", type: "tool", summary: "动画库", summaryPoints: [{ label: "定位", text: "动效库" }],
    signals: ["stars:9000", "actively maintained"],
    suggestedVerdict: "keep", suggestedReason: "widely used", confidence: 0.9,
    verdict: "keep", verdictBy: "human",
    usage: "integrate", playbook: { kind: "integrate", install: ["npm i gsap"], repo: null, prompt_text: null },
    tags: ["animation"], sourceUrl: null,
    serial: 31, scenarios: ["web-dev"],
    score: 4, scoreReason: "solid", sourceFacts: {},
    progress: "todo", progressLink: null, progressAt: null,
    reviewNote: null, reviewRequestedAt: null, reviewError: null,
    status: "active", supersededBy: null, statusAt: null, statusNote: null,
    overlap: { relation: "none", target: null, reason: "" },
    buildNotes: [{ at: "2026-09-21T00:00:00.000Z", by: "agent", text: "started" }],
    hasDeepAnalysis: false,
    syncedAt: null, deletedAt: null, createdAt: "2026-09-21T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z",
    capture: { kind: "url", objectKey: "obj_secret_key", thumbKey: "thumb_secret_key", text: null, url: "https://gsap.com" },
    retentionEligibleAt: null, retentionPurgedAt: null,
    supersededBySerial: null,
    deepAnalysis: null, deepAnalysisOf: null,
    deepRunState: null, deepRunErrorCode: null,
    openQuestions: ["需要付费吗"], enrichedAt: null,
    steps: [], sources: [],
    ...overrides
  } as unknown as CapabilityDetail;
}

describe("mcp tools", () => {
  it("caps the result count at 25 even when asked for more", async () => {
    const res = await searchCapabilities({ pool: fakePool([]) as never }, { query: "动效", limit: 999 });
    expect(res.items.length).toBeLessThanOrEqual(MAX_ITEMS);
  });

  it("resolves a serial like SKL-0031 to a card id", async () => {
    const pool = fakePool([{ id: "cap_1", capture_id: "cpt_1", updated_at: new Date("2026-09-21T00:00:00.000Z") }]);
    await expect(resolveSerial(pool as never, "SKL-0031"))
      .resolves.toEqual({ id: "cap_1", captureId: "cpt_1", updatedAt: "2026-09-21T00:00:00.000Z" });
  });

  it("returns null for a serial that is not a serial", async () => {
    await expect(resolveSerial(fakePool([]) as never, "不是编号")).resolves.toBeNull();
  });

  it("never returns image bytes, object keys or thumbnail keys", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "cap_1", capture_id: "cpt_1", updated_at: new Date("2026-09-21T00:00:00.000Z") }] })
      .mockResolvedValueOnce({ rows: [detailRow()] })
      .mockResolvedValueOnce({ rows: [] });
    const deps = { pool: { query } as never };

    const res = await getCapability(deps, { serial: "SKL-0031" });

    const json = JSON.stringify(res);
    expect(json).not.toMatch(/thumb_key|thumbKey|objectKey|image\/(png|jpeg)|base64/);
    expect(res).not.toBeNull();
    expect(res).toMatchObject({ serial: "TOL-0031", title: "GSAP", type: "tool", usage: "integrate" });
    // Deeper fields Task 3 adds beyond the search brief.
    expect(res).toHaveProperty("buildNotes", [{ at: "2026-09-21T00:00:00.000Z", by: "agent", text: "started" }]);
    expect(res).toHaveProperty("openQuestions", ["需要付费吗"]);
    expect(res).toHaveProperty("progress", "todo");
  });

  it("returns null when the serial does not resolve to a visible card", async () => {
    const deps = { pool: fakePool([]) as never };
    await expect(getCapability(deps, { serial: "SKL-9999" })).resolves.toBeNull();
  });

  it("every return value is plain JSON-serialisable data (no Date instances)", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "cap_1", capture_id: "cpt_1", updated_at: new Date("2026-09-21T00:00:00.000Z") }] })
      .mockResolvedValueOnce({ rows: [detailRow()] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await getCapability({ pool: { query } as never }, { serial: "SKL-0031" });
    // JSON.stringify would silently coerce a stray Date to a string too, so assert directly
    // against the parsed round-trip instead of just checking it stringifies without throwing.
    expect(JSON.parse(JSON.stringify(res))).toEqual(res);
  });

  it("listToBuild delegates to listTodoCapabilities and caps at limit", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [detailRow(), detailRow({ id: "cap_2", serial: 32 })] })
      .mockResolvedValueOnce({ rows: [{ total: "2" }] });
    const res = await listToBuild({ pool: { query } as never }, { limit: 1 });
    expect(res.total).toBe(2);
    expect(res.items.length).toBe(1);
    expect(res.items[0]).toMatchObject({ serial: "TOL-0031" });
  });

  it("listRecent delegates to listLibrary", async () => {
    const pool = fakePool([]);
    const res = await listRecent({ pool: pool as never });
    expect(res).toEqual({ total: 0, items: [] });
  });

  it("getStats delegates to libraryStats", async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ n: "0" }] })
        .mockResolvedValueOnce({ rows: [{ n: "0" }] })
        .mockResolvedValueOnce({ rows: [{ n: "0" }] })
    };
    const res = await getStats({ pool: pool as never });
    expect(res).toEqual({
      byType: { skill: 0, experience: 0, plugin: 0, prompt: 0, tool: 0, model: 0, other: 0 },
      total: 0, tagCount: 0, pending: 0, toBuild: 0
    });
  });
});
