import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityDetail } from "../library/queries";

const { setProgressMock, appendBuildNoteMock } = vi.hoisted(() => ({
  setProgressMock: vi.fn(),
  appendBuildNoteMock: vi.fn()
}));

vi.mock("../library/actions", () => ({ setProgress: setProgressMock }));
vi.mock("../library/build-notes", async () => {
  const actual = await vi.importActual<typeof import("../library/build-notes")>("../library/build-notes");
  return { ...actual, appendBuildNote: appendBuildNoteMock };
});

import { PAGE_SIZE } from "../library/queries";
import { appendNote, getCapability, getStats, listRecent, listToBuild, MAX_ITEMS, resolveSerial, searchCapabilities, setBuildProgress } from "./tools";

const fakePool = (rows: unknown[]) => ({ query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) });

/** A full CapabilityDetail row, camelCased as `getCapabilityDetail`'s SELECT returns it. */
function detailRow(overrides: Partial<CapabilityDetail> = {}) {
  return {
    id: "cap_1", captureId: "cpt_1", runId: "run_1", runPipeline: "p", runState: "done",
    title: "GSAP", type: "tool", summary: "动画库", summaryPoints: [{ label: "定位", text: "动效库" }],
    signals: ["stars:9000", "actively maintained"],
    suggestedVerdict: "keep", suggestedReason: "widely used", confidence: 0.9,
    verdict: "keep", verdictBy: "human",
    usage: "integrate", playbook: { kind: "integrate", install: ["npm i gsap"], repo: null },
    tags: ["animation"], sourceUrl: null,
    serial: 31, scenarios: ["web-dev"],
    score: 4, scoreReason: "solid", sourceFacts: {},
    progress: "todo", progressLink: null, progressAt: null,
    reviewNote: null, reviewRequestedAt: null, reviewError: null,
    status: "active", supersededBy: null, statusAt: null, statusNote: null,
    overlap: { relation: "none", target: null, reason: "" },
    buildNotes: [{ at: "2026-09-21T00:00:00.000Z", by: "agent", text: "started" }],
    prompts: [], promptUnresolved: 0,
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
  it("pins the advertised cap to PAGE_SIZE, since no tool takes a page/offset argument to reach anything beyond it", () => {
    expect(MAX_ITEMS).toBe(PAGE_SIZE);
  });

  it("caps the result count at MAX_ITEMS even when asked for more", async () => {
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

  it("returns verbatim prompts from the detail (Task 6)", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "cap_1", capture_id: "cpt_1", updated_at: new Date("2026-09-21T00:00:00.000Z") }] })
      .mockResolvedValueOnce({ rows: [detailRow({ prompts: [{ text: "原文" }], promptUnresolved: 0 })] })
      .mockResolvedValueOnce({ rows: [] });
    const deps = { pool: { query } as never };

    const res = await getCapability(deps, { serial: "SKL-0031" });

    expect(res).toHaveProperty("prompts", ["原文"]);
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

describe("mcp write tools", () => {
  const resolvedCard = { id: "cap_1", captureId: "cpt_1", updatedAt: "2026-09-21T00:00:00.000Z" };
  const deps = { pool: fakePool([{ id: "cap_1", capture_id: "cpt_1", updated_at: new Date(resolvedCard.updatedAt) }]) as never };

  beforeEach(() => {
    setProgressMock.mockReset();
    appendBuildNoteMock.mockReset();
  });

  it("refuses to move progress back to todo or planned", async () => {
    await expect(setBuildProgress(deps, { serial: "SKL-0031", progress: "todo" }))
      .resolves.toMatchObject({ ok: false });
    await expect(setBuildProgress(deps, { serial: "SKL-0031", progress: "planned" }))
      .resolves.toMatchObject({ ok: false });
    expect(setProgressMock).not.toHaveBeenCalled();
  });

  it("writes the progress and appends the note in the same call, using setProgress's new updatedAt for the note lock", async () => {
    const newUpdatedAt = "2026-09-21T00:00:01.000Z";
    setProgressMock.mockResolvedValueOnce({ ok: true, updatedAt: newUpdatedAt });
    appendBuildNoteMock.mockResolvedValueOnce({ ok: true, updatedAt: newUpdatedAt });

    const res = await setBuildProgress(deps, { serial: "SKL-0031", progress: "done", note: "装上就能用", by: "claude" });

    expect(res).toMatchObject({ ok: true, progress: "done", noteCount: 1 });
    expect(setProgressMock).toHaveBeenCalledWith(
      deps.pool,
      { id: "cap_1", expectedUpdatedAt: resolvedCard.updatedAt, progress: "done", link: null }
    );
    expect(appendBuildNoteMock).toHaveBeenCalledWith(
      deps.pool,
      expect.objectContaining({ id: "cap_1", expectedUpdatedAt: newUpdatedAt, note: expect.objectContaining({ by: "claude", text: "装上就能用" }) })
    );
  });

  it("reports a conflict instead of overwriting", async () => {
    setProgressMock.mockResolvedValueOnce({ ok: false, reason: "CONFLICT", message: "已在别处处理" });

    await expect(setBuildProgress(deps, { serial: "SKL-0031", progress: "done" }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining("别处") });
  });

  it("reports not-found for an unknown serial", async () => {
    const missingDeps = { pool: fakePool([]) as never };
    await expect(appendNote(missingDeps, { serial: "SKL-9999", note: "x" })).resolves.toMatchObject({ ok: false });
    expect(appendBuildNoteMock).not.toHaveBeenCalled();
  });

  it("appendNote resolves the serial, normalizes the note and appends it without touching progress", async () => {
    appendBuildNoteMock.mockResolvedValueOnce({ ok: true, updatedAt: "2026-09-21T00:00:02.000Z" });

    const res = await appendNote(deps, { serial: "SKL-0031", note: "还需要测一下移动端", by: "claude" });

    expect(res).toMatchObject({ ok: true, noteCount: 1 });
    expect(setProgressMock).not.toHaveBeenCalled();
    expect(appendBuildNoteMock).toHaveBeenCalledWith(
      deps.pool,
      expect.objectContaining({ id: "cap_1", expectedUpdatedAt: resolvedCard.updatedAt, note: expect.objectContaining({ by: "claude", text: "还需要测一下移动端" }) })
    );
  });
});
