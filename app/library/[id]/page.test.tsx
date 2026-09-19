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
});
