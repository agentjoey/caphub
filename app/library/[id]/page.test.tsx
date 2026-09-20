// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notFound = vi.fn(() => { throw new Error("NOT_FOUND"); });
const redirect = vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); });
vi.mock("next/navigation", () => ({ notFound, redirect }));

const getCapabilityDetail = vi.fn();
vi.mock("../../../lib/library/queries", () => ({ getCapabilityDetail: (...args: unknown[]) => getCapabilityDetail(...args) }));

vi.mock("../../../lib/analysis/scenarios", () => ({ loadScenarios: async () => [] }));
vi.mock("../../../lib/runtime", () => ({ getRuntime: () => ({ pool: {} }) }));
vi.mock("../../../lib/i18n/locale", () => ({ getLocale: async () => "zh" }));

const baseDetail = {
  id: "cab_1", captureId: "cap_1", title: "标题", type: "skill", summary: "摘要", signals: [],
  suggestedVerdict: "keep", suggestedReason: "", confidence: 0.9, verdict: "pending", verdictBy: null,
  usage: "integrate", playbook: { kind: "reference", steps: [] }, tags: [], sourceUrl: null,
  serial: null, scenarios: [], reviewNote: null, reviewRequestedAt: null, reviewError: null,
  syncedAt: null, deletedAt: null, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z",
  capture: { kind: "text", objectKey: null, thumbKey: null, text: "hi", url: null },
  retentionEligibleAt: null, retentionPurgedAt: null
};

beforeEach(() => {
  notFound.mockClear();
  redirect.mockClear();
  getCapabilityDetail.mockReset();
});
afterEach(() => vi.resetModules());

describe("library detail page", () => {
  it("redirects a pending card to /review#<id> instead of rendering the detail page", async () => {
    getCapabilityDetail.mockResolvedValueOnce({ ...baseDetail, verdict: "pending" });
    const { default: Page } = await import("./page");
    await expect(Page({ params: Promise.resolve({ id: "cab_1" }) })).rejects.toThrow("REDIRECT:/review#cab_1");
    expect(redirect).toHaveBeenCalledWith("/review#cab_1");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("does not redirect a decided (keep) card", async () => {
    getCapabilityDetail.mockResolvedValueOnce({ ...baseDetail, verdict: "keep", verdictBy: "human" });
    const { default: Page } = await import("./page");
    const result = await Page({ params: Promise.resolve({ id: "cab_1" }) });
    expect(redirect).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
  });

  it("still 404s a deleted card rather than redirecting", async () => {
    getCapabilityDetail.mockResolvedValueOnce({ ...baseDetail, verdict: "pending", deletedAt: "2026-09-19T00:00:00.000Z" });
    const { default: Page } = await import("./page");
    await expect(Page({ params: Promise.resolve({ id: "cab_1" }) })).rejects.toThrow("NOT_FOUND");
    expect(redirect).not.toHaveBeenCalled();
  });

  // Regression for the spurious-CONFLICT bug: ProgressControl and DetailActions each seed the
  // optimistic-lock token into their own useState on mount, and a router.refresh() after either
  // one saves re-renders this page with a newer detail.updatedAt but does NOT by itself remount
  // either child. Without key={detail.updatedAt} on both, the panel that didn't just save keeps
  // comparing against the token it first mounted with, and its next action always CONFLICTs.
  it("keys both ProgressControl and DetailActions on detail.updatedAt so a refresh with a newer token remounts them with the fresh value, not a stale one", async () => {
    function findByType(node: unknown, typeName: string): { key: unknown; props: Record<string, unknown> } | null {
      if (node === null || typeof node !== "object") return null;
      const el = node as { type?: unknown; props?: Record<string, unknown>; key?: unknown };
      if (typeof el.type === "function" && el.type.name === typeName) {
        return { key: el.key, props: el.props ?? {} };
      }
      const children = el.props?.children;
      const list = Array.isArray(children) ? children : [children];
      for (const child of list) {
        const found = findByType(child, typeName);
        if (found) return found;
      }
      return null;
    }

    const { default: Page } = await import("./page");

    const staleToken = "2026-09-19T00:00:00.000Z";
    getCapabilityDetail.mockResolvedValueOnce({
      ...baseDetail, verdict: "keep", verdictBy: "human", usage: "reference",
      progress: "todo", progressLink: null, updatedAt: staleToken
    });
    const before = await Page({ params: Promise.resolve({ id: "cab_1" }) });
    const progressBefore = findByType(before, "ProgressControl");
    const actionsBefore = findByType(before, "DetailActions");
    expect(progressBefore?.key).toBe(staleToken);
    expect(actionsBefore?.key).toBe(staleToken);

    // Simulate the progress-save -> router.refresh() cycle: the row's updated_at moved on.
    const freshToken = "2026-09-19T00:00:05.000Z";
    getCapabilityDetail.mockResolvedValueOnce({
      ...baseDetail, verdict: "keep", verdictBy: "human", usage: "reference",
      progress: "building", progressLink: null, updatedAt: freshToken
    });
    const after = await Page({ params: Promise.resolve({ id: "cab_1" }) });
    const progressAfter = findByType(after, "ProgressControl");
    const actionsAfter = findByType(after, "DetailActions");

    // The panel that did NOT just save (DetailActions) must be given the NEW token as both its
    // key (forcing a remount that re-seeds its internal lock-token state) and its updatedAt prop
    // — never the stale one it was first mounted with.
    expect(actionsAfter?.key).toBe(freshToken);
    expect(actionsAfter?.props.updatedAt).toBe(freshToken);
    expect(actionsAfter?.key).not.toBe(staleToken);
    // And ProgressControl itself also gets remounted on the fresh token.
    expect(progressAfter?.key).toBe(freshToken);
    expect(progressAfter?.props.updatedAt).toBe(freshToken);
  });

  // Regression: detail.sourceUrl is model-supplied (analysis's source_url) and the zod schema
  // accepts any z.string().url() value, including javascript:/data: — the page must only render
  // an <a> for it when it's http(s), never build an anchor from an unsafe scheme.
  it("only renders detail.sourceUrl as an anchor when it's http(s)", async () => {
    function findAnchor(node: unknown): { props: Record<string, unknown> } | null {
      if (node === null || typeof node !== "object") return null;
      const el = node as { type?: unknown; props?: Record<string, unknown> };
      if (el.type === "a") return { props: el.props ?? {} };
      const children = el.props?.children;
      const list = Array.isArray(children) ? children : [children];
      for (const child of list) {
        const found = findAnchor(child);
        if (found) return found;
      }
      return null;
    }

    const { default: Page } = await import("./page");

    getCapabilityDetail.mockResolvedValueOnce({ ...baseDetail, verdict: "keep", verdictBy: "human", sourceUrl: "javascript:alert(1)" });
    const unsafe = await Page({ params: Promise.resolve({ id: "cab_1" }) });
    expect(findAnchor(unsafe)).toBeNull();

    getCapabilityDetail.mockResolvedValueOnce({ ...baseDetail, verdict: "keep", verdictBy: "human", sourceUrl: "https://example.com/a" });
    const safe = await Page({ params: Promise.resolve({ id: "cab_1" }) });
    expect(findAnchor(safe)?.props.href).toBe("https://example.com/a");
  });
});
