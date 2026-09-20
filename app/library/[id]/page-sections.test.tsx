// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() })
}));

const getCapabilityDetail = vi.fn();
vi.mock("../../../lib/library/queries", () => ({ getCapabilityDetail: (...args: unknown[]) => getCapabilityDetail(...args) }));
vi.mock("../../../lib/analysis/scenarios", () => ({
  loadScenarios: async () => [{ slug: "scraping", labelZh: "抓取", labelEn: "Scraping", keywords: [] }]
}));
vi.mock("../../../lib/runtime", () => ({ getRuntime: () => ({ pool: {} }) }));
vi.mock("../../../lib/i18n/locale", () => ({ getLocale: async () => "zh" }));
vi.mock("../../actions", () => ({
  decideAction: vi.fn(), editSuggestionAction: vi.fn(), rerunAction: vi.fn(),
  reviewAction: vi.fn(), softDeleteAction: vi.fn(), setProgressAction: vi.fn()
}));

const baseDetail = {
  id: "cab_1", captureId: "cap_1", title: "Scrapling", type: "skill", summary: "一句话总结文字",
  signals: ["信号一", "信号二"], suggestedVerdict: "keep", suggestedReason: "", confidence: 0.9,
  verdict: "keep", verdictBy: "human", usage: "integrate",
  playbook: { kind: "reference", points: ["要点一"] }, tags: ["python"], sourceUrl: null,
  serial: 7, scenarios: ["scraping"], reviewNote: null, reviewRequestedAt: null, reviewError: null,
  syncedAt: null, deletedAt: null, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z",
  capture: { kind: "text", objectKey: null, thumbKey: null, text: "hi", url: null },
  retentionEligibleAt: null, retentionPurgedAt: null,
  score: 4, scoreReason: "成熟且好装", sourceFacts: { repo_url: "https://github.com/a/b", stars: 12, as_of: "2026-09-20" },
  progress: "todo", progressLink: null, progressAt: null,
  steps: [], sources: [], runPipeline: "mixed", runState: "done", runId: "run_1"
};

async function renderDetail(overrides: Record<string, unknown> = {}) {
  getCapabilityDetail.mockResolvedValueOnce({ ...baseDetail, ...overrides });
  const { default: Page } = await import("./page");
  return render(await Page({ params: Promise.resolve({ id: "cab_1" }) }));
}

beforeEach(() => getCapabilityDetail.mockReset());
afterEach(() => { cleanup(); vi.resetModules(); });

describe("library detail page sections", () => {
  it("orders the sections 总结 → 场景/用法/评分 → 价值信号 → 怎么用 → 来源事实 → 详情", async () => {
    const { container } = await renderDetail();
    const text = container.textContent ?? "";
    const at = (needle: string) => {
      const i = text.indexOf(needle);
      expect(i, `missing: ${needle}`).toBeGreaterThan(-1);
      return i;
    };
    const order = [at("一句话总结"), at("抓取"), at("价值信号"), at("怎么用"), at("来源事实"), at("详情")];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("puts the score badge next to the title with the reason as its tooltip, not inline with the facts", async () => {
    const { container } = await renderDetail();
    const badge = container.querySelector(".page-title .badge--score")!;
    expect(badge.textContent).toBe("★ 4/5");
    expect(badge.getAttribute("title")).toBe("成熟且好装");
    expect(container.querySelector(".source-facts")!.textContent).not.toContain("成熟且好装");
  });

  it("omits the score badge and its reason line entirely when the card is unscored", async () => {
    const { container } = await renderDetail({ score: null, scoreReason: null });
    expect(container.querySelector(".badge--score")).toBeNull();
    expect(container.textContent).not.toContain("★");
  });

  it("drops the whole source-facts block when there are no facts", async () => {
    const { container } = await renderDetail({ sourceFacts: {} });
    expect(container.querySelector(".source-facts")).toBeNull();
    expect(container.textContent).not.toContain("来源事实");
  });

  it("shows the progress control only for reference cards", async () => {
    const integrate = await renderDetail({ usage: "integrate" });
    expect(integrate.container.querySelector(".progress-control")).toBeNull();
    cleanup();
    vi.resetModules();
    const reference = await renderDetail({ usage: "reference", progress: "planned" });
    expect(reference.container.querySelector(".progress-control")).toBeTruthy();
    expect(screen.getByRole("button", { name: "已排期" }).getAttribute("aria-pressed")).toBe("true");
  });
});
