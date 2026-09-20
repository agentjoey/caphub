// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DeepAnalysis } from "../../lib/analysis/card";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
const deepAnalysisAction = vi.fn();
vi.mock("../../app/actions", () => ({ deepAnalysisAction: (...args: unknown[]) => deepAnalysisAction(...args) }));

import { DeepAnalysisSection } from "./deep-analysis";

const analysis: DeepAnalysis = {
  headline: "自托管的浏览器自动化框架",
  architecture: { summary: "三层：调度、浏览器池、抽取器", points: ["调度器用队列", "浏览器池复用会话", "抽取器可插拔"] },
  implementation: { summary: "Python + Playwright", points: ["异步 IO", "重试带退避", "指标走 Prometheus"] },
  use_cases: [
    { title: "批量抓取", detail: "定时抓取上千页面" },
    { title: "登录态采集", detail: "复用 cookie 抓取" },
    { title: "截图留档", detail: "定期存档页面" }
  ],
  cases: [{ title: "某电商", detail: "日抓百万页", source: 1 }],
  feedback: { positive: [{ text: "上手快", source: 0 }], negative: [{ text: "文档薄", source: null }] },
  risks: ["依赖上游浏览器版本", "并发高时内存吃紧"],
  sources: [
    { title: "官方文档", url: "https://example.com/docs" },
    { title: "案例博客", url: "https://blog.example.org/post" }
  ]
};

function renderSection(overrides: Partial<React.ComponentProps<typeof DeepAnalysisSection>> = {}) {
  return render(
    <DeepAnalysisSection
      captureId="cap_1"
      analysis={null}
      analysisOf={null}
      runState={null}
      errorCode={null}
      {...overrides}
    />
  );
}

beforeEach(() => { deepAnalysisAction.mockReset(); refresh.mockReset(); });
afterEach(cleanup);

describe("DeepAnalysisSection — the three pre-result states", () => {
  it("offers the trigger and states the cost when nothing has been generated", () => {
    const { container } = renderSection();
    expect(screen.getByRole("button", { name: "开始深度分析" })).toBeTruthy();
    expect(container.textContent).toContain("约 8 次检索与分析调用");
    expect(container.querySelector(".deep-section")).toBeNull();
  });

  it("shows the running state and offers no second trigger while a run is in flight", () => {
    for (const runState of ["queued", "running"]) {
      const { container } = renderSection({ runState });
      expect(container.textContent).toContain("深度分析进行中");
      expect(container.querySelector("button")).toBeNull();
      cleanup();
    }
  });

  it("shows the failure reason and a retry button after a failed run", () => {
    const { container } = renderSection({ runState: "failed", errorCode: "TIMEOUT" });
    expect(container.textContent).toContain("上次深度分析失败：模型响应超时");
    expect(screen.getByRole("button", { name: "重新深挖" })).toBeTruthy();
  });

  it("queues a run for the capture and reports it queued, without a second press", async () => {
    deepAnalysisAction.mockResolvedValue({ ok: true, updatedAt: "2026-09-20T00:00:00.000Z" });
    const { container } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: "开始深度分析" }));
    await waitFor(() => expect(deepAnalysisAction).toHaveBeenCalledWith("cap_1"));
    await waitFor(() => expect(container.textContent).toContain("已排队"));
    expect(container.querySelector("button")).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it("drops the local 已排队 notice once the server reports the finished run", async () => {
    deepAnalysisAction.mockResolvedValue({ ok: true, updatedAt: "2026-09-20T00:00:00.000Z" });
    const { container, rerender } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: "开始深度分析" }));
    await waitFor(() => expect(container.textContent).toContain("已排队"));
    // router.refresh() brings the finished analysis down — the local queued state must yield to it
    // instead of sitting above the result forever.
    rerender(
      <DeepAnalysisSection captureId="cap_1" analysis={analysis} analysisOf={null} runState="done" errorCode={null} />
    );
    expect(container.textContent).not.toContain("已排队");
    expect(container.querySelector(".deep-strip__headline")).toBeTruthy();
  });

  it("names a generic reason when a failed run recorded no error code", () => {
    const { container } = renderSection({ runState: "failed", errorCode: null });
    expect(container.textContent).toContain("上次深度分析失败：原因未记录");
  });

  it("surfaces a rejected trigger's own message and keeps the button usable", async () => {
    deepAnalysisAction.mockResolvedValue({ ok: false, reason: "CONFLICT", message: "深度分析已在排队或进行中" });
    const { container } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: "开始深度分析" }));
    await waitFor(() => expect(container.textContent).toContain("深度分析已在排队或进行中"));
    expect(screen.getByRole("button", { name: "开始深度分析" }).hasAttribute("disabled")).toBe(false);
  });
});

describe("DeepAnalysisSection — the result", () => {
  it("leads with a summary strip: headline, best-fit scenario, top risk and the source count", () => {
    const { container } = renderSection({ analysis });
    const strip = container.querySelector(".deep-strip")!;
    expect(strip.textContent).toContain("自托管的浏览器自动化框架");
    expect(strip.textContent).toContain("最适合场景：批量抓取");
    expect(strip.textContent).toContain("最大风险：依赖上游浏览器版本");
    expect(strip.textContent).toContain("来源 2");
  });

  it("truncates an over-long 最大风险 chip and keeps the full text in its tooltip", () => {
    const long = "依赖上游浏览器版本，升级后可能整条抓取链路都要重新适配一遍";
    const { container } = renderSection({ analysis: { ...analysis, risks: [long, "内存吃紧"] } });
    const chip = [...container.querySelectorAll(".deep-strip__chips .chip")].find((c) => c.textContent!.startsWith("最大风险"))!;
    expect(chip.textContent!.endsWith("…")).toBe(true);
    expect(chip.textContent!.length).toBeLessThan(long.length);
    expect(chip.getAttribute("title")).toBe(long);
  });

  it("renders six collapsible sections with item counts, only 架构 expanded, and bullets rather than paragraphs", () => {
    const { container } = renderSection({ analysis });
    const sections = [...container.querySelectorAll<HTMLDetailsElement>(".deep-section")];
    expect(sections.map((s) => s.querySelector(".deep-section__title")!.textContent))
      .toEqual(["架构", "技术实现", "适用场景", "案例", "口碑与争议", "风险"]);
    expect(sections.map((s) => s.querySelector(".deep-section__count")!.textContent))
      .toEqual(["3 条", "3 条", "3 条", "1 条", "2 条", "2 条"]);
    expect(sections.filter((s) => s.open).map((s) => s.querySelector(".deep-section__title")!.textContent)).toEqual(["架构"]);

    const architecture = sections[0];
    expect(architecture.querySelector(".deep-section__summary")!.textContent).toBe("三层：调度、浏览器池、抽取器");
    expect([...architecture.querySelectorAll(".deep-points li")].map((li) => li.textContent))
      .toEqual(["调度器用队列", "浏览器池复用会话", "抽取器可插拔"]);
    // Every rendered item is a list item — no section ever renders a prose paragraph of content.
    expect(container.querySelectorAll(".deep-points li").length).toBeGreaterThan(10);
  });

  it("cites a feedback point that names a source, and leaves a general impression (source: null) uncited", () => {
    const { container } = renderSection({ analysis });
    const feedback = [...container.querySelectorAll(".deep-section")].find((s) => s.querySelector(".deep-section__title")!.textContent === "口碑与争议")!;
    const [praise, criticism] = [...feedback.querySelectorAll(".deep-points li")];
    expect(praise.textContent).toBe("上手快[1]");
    expect(praise.querySelector(".deep-ref")!.getAttribute("href")).toBe("#deep-source-1");
    expect(criticism.textContent).toBe("文档薄");
    expect(criticism.querySelector(".deep-ref")).toBeNull();
  });

  it("leaves a feedback point whose citation points outside the source list uncited rather than dead-linking", () => {
    const { container } = renderSection({
      analysis: { ...analysis, feedback: { positive: [{ text: "上手快", source: 9 }], negative: [] } }
    });
    expect(container.textContent).toContain("上手快");
    const feedback = [...container.querySelectorAll(".deep-section")].find((s) => s.querySelector(".deep-section__title")!.textContent === "口碑与争议")!;
    expect(feedback.querySelector(".deep-ref")).toBeNull();
  });

  it("cites each case with a [n] superscript pointing at the collapsed source list, and shows 标题 · 域名", () => {
    const { container } = renderSection({ analysis });
    const ref = container.querySelector(".deep-ref")!;
    expect(ref.textContent).toBe("[2]");
    expect(ref.getAttribute("href")).toBe("#deep-source-2");
    const cited = container.querySelector("#deep-source-2")!;
    expect(cited.textContent).toContain("案例博客");
    expect(cited.textContent).toContain("blog.example.org");
    expect(cited.querySelector("a")!.getAttribute("href")).toBe("https://blog.example.org/post");
    // The source list itself stays collapsed until a citation is followed — clicking one opens it
    // explicitly, since not every browser opens a <details> to reveal a fragment target.
    const sources = container.querySelector<HTMLDetailsElement>(".deep-sources")!;
    expect(sources.open).toBe(false);
    fireEvent.click(ref);
    expect(sources.open).toBe(true);
  });

  it("omits an empty section entirely rather than rendering an empty heading", () => {
    const { container } = renderSection({
      analysis: { ...analysis, cases: [], feedback: { positive: [], negative: [] }, sources: [] }
    });
    const titles = [...container.querySelectorAll(".deep-section__title")].map((t) => t.textContent);
    expect(titles).toEqual(["架构", "技术实现", "适用场景", "风险"]);
    expect(container.querySelector(".deep-sources")).toBeNull();
    expect(container.textContent).toContain("来源 0");
  });

  it("degrades instead of crashing on a stored blob missing whole fields", () => {
    const partial = { headline: "只有标题" } as unknown as DeepAnalysis;
    const { container } = renderSection({ analysis: partial });
    expect(container.querySelector(".deep-strip__headline")!.textContent).toBe("只有标题");
    expect(container.querySelectorAll(".deep-section")).toHaveLength(0);
  });

  it("drops a case whose citation points outside the source list instead of rendering a dead link", () => {
    const { container } = renderSection({ analysis: { ...analysis, cases: [{ title: "某电商", detail: "日抓百万页", source: 9 }] } });
    const cases = [...container.querySelectorAll(".deep-section")].find((s) => s.querySelector(".deep-section__title")!.textContent === "案例")!;
    expect(cases.textContent).toContain("某电商");
    expect(cases.querySelector(".deep-ref")).toBeNull();
  });

  it("still renders a pre-grounding blob whose feedback points are bare strings", () => {
    const legacy = { ...analysis, feedback: { positive: ["上手快"], negative: [] } } as unknown as DeepAnalysis;
    const { container } = renderSection({ analysis: legacy });
    const feedback = [...container.querySelectorAll(".deep-section")].find((s) => s.querySelector(".deep-section__title")!.textContent === "口碑与争议")!;
    expect(feedback.querySelector(".deep-points li")!.textContent).toBe("上手快");
    expect(feedback.querySelector(".deep-ref")).toBeNull();
  });

  it("closes the summary with the card version the analysis was based on", () => {
    const { container } = renderSection({ analysis, analysisOf: "2026-09-19T02:00:00.000Z" });
    expect(container.querySelector(".deep-analysis__based-on")!.textContent).toContain("依据 2026-09-19 10:00 时的卡片内容");
  });

  it("collapses every section, including 架构, on a narrow viewport", async () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      const { container } = renderSection({ analysis });
      await waitFor(() => expect([...container.querySelectorAll<HTMLDetailsElement>(".deep-section")].every((s) => !s.open)).toBe(true));
      expect(matchMedia).toHaveBeenCalledWith("(max-width: 720px)");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
