// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() })
}));

const getCapabilityDetail = vi.fn();
vi.mock("../../../../lib/library/queries", () => ({ getCapabilityDetail: (...args: unknown[]) => getCapabilityDetail(...args) }));
vi.mock("../../../../lib/analysis/scenarios", () => ({
  loadScenarios: async () => [{ slug: "scraping", labelZh: "抓取", labelEn: "Scraping", keywords: [] }]
}));
vi.mock("../../../../lib/runtime", () => ({ getRuntime: () => ({ pool: {} }) }));
vi.mock("../../../../lib/i18n/locale", () => ({ getLocale: async () => "zh" }));
const setProgressAction = vi.fn();
vi.mock("../../../actions", () => ({
  decideAction: vi.fn(), editSuggestionAction: vi.fn(), rerunAction: vi.fn(),
  reviewAction: vi.fn(), softDeleteAction: vi.fn(), deepAnalysisAction: vi.fn(),
  setProgressAction: (...args: unknown[]) => setProgressAction(...args)
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
  steps: [], sources: [], runPipeline: "mixed", runState: "done", runId: "run_1",
  deepAnalysis: null, deepAnalysisOf: null, deepRunState: null, deepRunErrorCode: null,
  openQuestions: [], enrichedAt: null, buildNotes: []
};

const DEEP = {
  headline: "自托管的浏览器自动化框架",
  architecture: { summary: "三层", points: ["a", "b", "c"] },
  implementation: { summary: "Python", points: ["a", "b", "c"] },
  use_cases: [{ title: "批量抓取", detail: "定时抓取" }, { title: "b", detail: "d" }, { title: "c", detail: "e" }],
  cases: [],
  feedback: { positive: [], negative: [] },
  risks: ["依赖上游浏览器版本", "内存吃紧"],
  sources: []
};

async function renderDetail(overrides: Record<string, unknown> = {}) {
  getCapabilityDetail.mockResolvedValueOnce({ ...baseDetail, ...overrides });
  const { default: Page } = await import("./page");
  return render(await Page({ params: Promise.resolve({ id: "cab_1" }) }));
}

beforeEach(() => { getCapabilityDetail.mockReset(); setProgressAction.mockReset(); });
afterEach(() => { cleanup(); vi.resetModules(); });

describe("library detail page sections", () => {
  // Regression (M3.5 walkthrough): saving self-build progress left TWO 自研进度 panels on the
  // page. ProgressControl and DetailActions were both keyed on detail.updatedAt — two siblings
  // of the same children list sharing one key — so the router.refresh() that follows a save
  // re-rendered the page with duplicated children.
  it("still shows exactly one 自研进度 panel after a progress save and the refresh that follows", async () => {
    const stale = "2026-09-19T00:00:00.000Z";
    const fresh = "2026-09-19T00:00:05.000Z";
    setProgressAction.mockResolvedValue({ ok: true, updatedAt: fresh });
    const { default: Page } = await import("./page");

    getCapabilityDetail.mockResolvedValueOnce({ ...baseDetail, usage: "reference", progress: "todo", updatedAt: stale });
    const { container, rerender } = render(await Page({ params: Promise.resolve({ id: "cab_1" }) }));
    expect(container.querySelectorAll(".progress-control")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "自研中" }));
    fireEvent.click(screen.getByRole("button", { name: "保存进度" }));
    await waitFor(() => expect(setProgressAction).toHaveBeenCalledWith("cab_1", stale, "building", ""));

    // router.refresh(): the same page re-renders from the server with the newer token.
    getCapabilityDetail.mockResolvedValueOnce({ ...baseDetail, usage: "reference", progress: "building", updatedAt: fresh });
    rerender(await Page({ params: Promise.resolve({ id: "cab_1" }) }));
    expect(container.querySelectorAll(".progress-control")).toHaveLength(1);
    expect(screen.getAllByRole("heading", { name: "自研进度" })).toHaveLength(1);
  });

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

  it("promotes 深度分析 above 一句话总结 once an analysis exists, leaving the rest of the order alone", async () => {
    const { container } = await renderDetail({ deepAnalysis: DEEP, deepAnalysisOf: "2026-09-19T00:00:00.000Z" });
    const text = container.textContent ?? "";
    const at = (needle: string) => {
      const i = text.indexOf(needle);
      expect(i, `missing: ${needle}`).toBeGreaterThan(-1);
      return i;
    };
    // "直接整合" (usage badge), not "抓取" (a scenario chip), because the DEEP fixture's use case
    // title contains "抓取" as a substring ("批量抓取"), which would false-match once the deep
    // analysis section is promoted ahead of the scenario chips.
    const order = [at("深度分析"), at("一句话总结"), at("直接整合"), at("价值信号"), at("怎么用"), at("来源事实"), at("详情")];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it.each(["running", "failed"] as const)(
    "keeps 深度分析 in its usual place (not promoted) while runState is %s and no analysis exists yet",
    async (deepRunState) => {
      const { container } = await renderDetail({ deepAnalysis: null, deepRunState });
      const text = container.textContent ?? "";
      const at = (needle: string) => {
        const i = text.indexOf(needle);
        expect(i, `missing: ${needle}`).toBeGreaterThan(-1);
        return i;
      };
      // Unpromoted position: after 来源事实 (right column) and before 详情, same as when there
      // is no analysis at all — i.e. the trigger/running/failed panel was NOT moved to the top.
      expect(at("一句话总结")).toBeLessThan(at("来源事实"));
      expect(at("来源事实")).toBeLessThan(at("深度分析"));
      expect(at("深度分析")).toBeLessThan(at("详情"));
    }
  );

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

  it("always offers the 深度分析 section, and badges the title only once an analysis exists", async () => {
    const without = await renderDetail();
    expect(without.container.querySelector(".deep-analysis")).toBeTruthy();
    expect(without.container.querySelector(".page-title .badge--deep")).toBeNull();
    cleanup();
    vi.resetModules();

    const withDeep = await renderDetail({ deepAnalysis: DEEP, deepAnalysisOf: "2026-09-19T00:00:00.000Z" });
    expect(withDeep.container.querySelector(".page-title .badge--deep")!.textContent).toBe("🔬 已深挖");
    expect(withDeep.container.querySelector(".deep-strip__headline")!.textContent).toBe("自托管的浏览器自动化框架");
  });

  it("collapses the capture preview behind a closed-by-default 原始投递 <details>", async () => {
    const { container } = await renderDetail();
    const details = container.querySelector("details.capture-collapse") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("原始投递");
  });

  it("omits the 待核实 section when open_questions is empty", async () => {
    const { container } = await renderDetail({ openQuestions: [] });
    expect(container.textContent).not.toContain("待核实");
  });

  it("shows a 待核实 list, positioned after 价值信号 and before 怎么用, when open_questions is non-empty", async () => {
    const { container } = await renderDetail({ openQuestions: ["是否需要登录才能用", "免费额度上限是多少"] });
    const text = container.textContent ?? "";
    const at = (needle: string) => {
      const i = text.indexOf(needle);
      expect(i, `missing: ${needle}`).toBeGreaterThan(-1);
      return i;
    };
    expect(at("价值信号")).toBeLessThan(at("待核实"));
    expect(at("待核实")).toBeLessThan(at("怎么用"));
    expect(screen.getByText("是否需要登录才能用")).toBeTruthy();
    expect(screen.getByText("免费额度上限是多少")).toBeTruthy();
  });

  it("shows a lighter 已补充调研 marker next to the title only when enrichedAt is set", async () => {
    const without = await renderDetail({ enrichedAt: null });
    expect(without.container.querySelector(".page-title .badge--enriched")).toBeNull();
    cleanup();
    vi.resetModules();

    const withEnriched = await renderDetail({ enrichedAt: "2026-09-20T01:00:00.000Z" });
    const badge = withEnriched.container.querySelector(".page-title .badge--enriched");
    expect(badge).toBeTruthy();
    expect(badge!.textContent).toContain("已补充调研");
  });

  it("keeps 深度分析 promoted to the top when both a deep analysis and enrichment marker are present", async () => {
    const { container } = await renderDetail({
      deepAnalysis: DEEP, deepAnalysisOf: "2026-09-19T00:00:00.000Z", enrichedAt: "2026-09-20T01:00:00.000Z"
    });
    const text = container.textContent ?? "";
    const at = (needle: string) => {
      const i = text.indexOf(needle);
      expect(i, `missing: ${needle}`).toBeGreaterThan(-1);
      return i;
    };
    expect(at("深度分析")).toBeLessThan(at("一句话总结"));
  });

  describe("detail.sourceUrl vs 怎么用's playbook repo link (dedup)", () => {
    // Pre-existing bug (not from M3.8): the repo/source link rendered twice -- once inside 怎么用's
    // playbook block, once again as the standalone detail.sourceUrl line right below it.
    // sourceFacts is cleared in these fixtures — SourceFacts renders its own repo_url link in a
    // separate .panel (source-facts-panel), which would otherwise be indistinguishable here from
    // 怎么用's link when both happen to share the same URL text.
    it("suppresses the standalone source line when it duplicates the playbook's repo link", async () => {
      const { container } = await renderDetail({
        playbook: { kind: "integrate", install: [], repo: "https://github.com/a/b" },
        sourceUrl: "https://github.com/a/b", sourceFacts: {}
      });
      const links = Array.from(container.querySelectorAll(".panel a")).filter((a) => a.textContent === "https://github.com/a/b");
      expect(links).toHaveLength(1);
      expect(container.querySelector(".detail-source")).toBeNull();
    });

    it("still normalizes a trailing slash before comparing", async () => {
      const { container } = await renderDetail({
        playbook: { kind: "integrate", install: [], repo: "https://github.com/a/b" },
        sourceUrl: "https://github.com/a/b/", sourceFacts: {}
      });
      expect(container.querySelector(".detail-source")).toBeNull();
    });

    it("still shows the standalone source line when it differs from the playbook's repo link", async () => {
      const { container } = await renderDetail({
        playbook: { kind: "integrate", install: [], repo: "https://github.com/a/b" },
        sourceUrl: "https://example.com/write-up", sourceFacts: {}
      });
      expect(container.querySelector(".detail-source")).toBeTruthy();
      expect(container.querySelector(".detail-source")!.textContent).toBe("https://example.com/write-up");
    });

    it("still shows the standalone source line for a reference/experience playbook (no repo link to dedupe against)", async () => {
      const { container } = await renderDetail({
        playbook: { kind: "reference", points: ["要点一"] },
        sourceUrl: "https://example.com/article", sourceFacts: {}
      });
      expect(container.querySelector(".detail-source")).toBeTruthy();
    });
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
