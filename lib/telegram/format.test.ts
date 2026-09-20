import { describe, expect, it } from "vitest";
import { errorLabel } from "../library/labels";
import { decodeDecision } from "./router";
import { formatDeepSummary, formatResult, TELEGRAM_MESSAGE_MAX_LEN, type DecidedCardInput, type FailedCardInput, type TodoCardInput } from "./format";
import type { DeepAnalysis } from "../analysis/card";

const base: DecidedCardInput = {
  status: "keep",
  id: "cab_deadbeefcafef00d",
  title: "示例标题",
  type: "skill",
  usage: "integrate",
  suggestedVerdict: "keep",
  suggestedReason: "很实用",
  summary: "这是一段摘要。",
  tags: ["rag", "web-scraping"],
  scenarioLabels: ["编程", "自动化"],
  serial: 7,
  updatedAt: "2026-09-20T00:00:00.000Z"
};

const failedBase: FailedCardInput = {
  status: "failed",
  id: "cab_deadbeefcafef00d",
  updatedAt: "2026-09-20T00:00:00.000Z",
  errorCode: null
};

describe("formatResult — keep", () => {
  it("renders the serial, title, meta, scenarios, tags and a web link, plus the 深度分析 button row", () => {
    const out = formatResult(base);
    expect(out.text).toContain("✅ 已保留 · SKL-0007");
    expect(out.text).toContain("<b>示例标题</b>");
    expect(out.text).toContain("类型：技能 · 用法：直接整合");
    expect(out.text).toContain("场景：编程、自动化");
    expect(out.text).toContain("标签：rag、web-scraping");
    expect(out.text).toContain("/library/cab_deadbeefcafef00d");
    // M3.6 Task 4: a kept card is the one card deep analysis applies to, so it carries the
    // 🔬 深度分析 button (decoding back to the "deep" action) and a web link.
    const kb = out.replyMarkup?.inline_keyboard;
    expect(kb?.flat().map((b) => b.text)).toEqual(["🔬 深度分析", "🔗 去 web"]);
    expect(decodeDecision(kb![0]![0]!.callback_data!)).toEqual({ action: "deep", capabilityId: base.id, updatedAt: base.updatedAt });
    expect(kb?.[0]?.[1]?.url).toContain("/library/cab_deadbeefcafef00d");
  });

  it("shows 🔬 已深挖 only once the card has a stored deep analysis", () => {
    expect(formatResult(base).text).not.toContain("已深挖");
    expect(formatResult({ ...base, deepAnalyzed: true }).text).toContain("🔬 已深挖");
  });

  it("omits the serial segment when none is stored", () => {
    const out = formatResult({ ...base, serial: null });
    expect(out.text).toContain("✅ 已保留");
    expect(out.text).not.toContain("SKL-");
  });

  it("escapes HTML-significant characters in card-derived text", () => {
    const out = formatResult({ ...base, title: "<script>&", tags: ["<b>"] });
    expect(out.text).toContain("&lt;script&gt;&amp;");
    expect(out.text).not.toContain("<script>");
    expect(out.text).toContain("&lt;b&gt;");
  });

  it("never renders internal ids as text (only the display serial)", () => {
    const out = formatResult(base);
    // The id appears only inside the escaped web link path, never as bare "cab_..." text.
    const withoutLink = out.text.replace(/https:\/\/\S+/g, "");
    expect(withoutLink).not.toContain("cab_deadbeefcafef00d");
  });

  it("renders the web link as an HTML anchor labeled 详情, not visible raw URL text", () => {
    const out = formatResult(base);
    expect(out.text).toContain('<a href="https://caphub.agentjoey.ai/library/cab_deadbeefcafef00d">详情</a>');
  });

  it("AJ-298: shows 评分：★4/5 with the reason when the card has a score", () => {
    const out = formatResult({ ...base, score: 4, scoreReason: "生态成熟" });
    expect(out.text).toContain("评分：★4/5 · 生态成熟");
  });

  it("AJ-298: omits the 评分 line when the card has no score (never renders ★0/5)", () => {
    const out = formatResult({ ...base, score: null, scoreReason: null });
    expect(out.text).not.toContain("评分");
    expect(out.text).not.toContain("★");
  });
});

describe("formatResult — discard", () => {
  it("renders the discard header, title, one-line reason and web link; no serial, no buttons", () => {
    const out = formatResult({ ...base, status: "discard", suggestedReason: "内容过旧" });
    expect(out.text).toContain("🗑 已丢弃");
    expect(out.text).toContain("<b>示例标题</b>");
    expect(out.text).toContain("内容过旧");
    expect(out.text).not.toContain("SKL-");
    expect(out.replyMarkup).toBeUndefined();
  });

  it("also links via an HTML anchor labeled 详情", () => {
    const out = formatResult({ ...base, status: "discard" });
    expect(out.text).toContain('<a href="https://caphub.agentjoey.ai/library/cab_deadbeefcafef00d">详情</a>');
  });

  it("AJ-298: shows 评分：★4/5 with the reason when the card has a score", () => {
    const out = formatResult({ ...base, status: "discard", score: 2, scoreReason: "内容过旧" });
    expect(out.text).toContain("评分：★2/5 · 内容过旧");
  });

  it("AJ-298: omits the 评分 line when the card has no score", () => {
    const out = formatResult({ ...base, status: "discard", score: null, scoreReason: null });
    expect(out.text).not.toContain("评分");
  });
});

describe("formatResult — pending", () => {
  it("renders title, suggestion+reason, truncated summary, meta and four buttons two-per-row", () => {
    const longSummary = "字".repeat(400);
    const out = formatResult({ ...base, status: "pending", summary: longSummary });
    expect(out.text).toContain("<b>示例标题</b>");
    expect(out.text).toContain("建议：保留 · 很实用");
    expect(out.text).toContain("总结：" + "字".repeat(300));
    expect(out.text).not.toContain("字".repeat(301));
    expect(out.text).not.toContain("SKL-");

    const kb = out.replyMarkup?.inline_keyboard;
    expect(kb).toHaveLength(2);
    expect(kb?.[0]).toHaveLength(2);
    expect(kb?.[1]).toHaveLength(2);
    expect(kb?.[0]?.[0]?.text).toBe("✅ 保留");
    expect(kb?.[0]?.[1]?.text).toBe("🗑 丢弃");
    expect(kb?.[1]?.[0]?.text).toBe("♻️ 重跑分析");
    expect(kb?.[1]?.[1]?.text).toBe("🔗 去 web");

    // The three non-URL buttons are callbacks that decode back to keep/discard/rerun for this id.
    const keepData = kb?.[0]?.[0]?.callback_data;
    const discardData = kb?.[0]?.[1]?.callback_data;
    const rerunData = kb?.[1]?.[0]?.callback_data;
    expect(decodeDecision(keepData!)).toEqual({ action: "keep", capabilityId: base.id, updatedAt: base.updatedAt });
    expect(decodeDecision(discardData!)).toEqual({ action: "discard", capabilityId: base.id, updatedAt: base.updatedAt });
    expect(decodeDecision(rerunData!)).toEqual({ action: "rerun", capabilityId: base.id, updatedAt: base.updatedAt });
    expect(kb?.[1]?.[1]?.url).toContain("/library/cab_deadbeefcafef00d");
  });

  it("renders a discard suggestion label", () => {
    const out = formatResult({ ...base, status: "pending", suggestedVerdict: "discard" });
    expect(out.text).toContain("建议：丢弃");
  });

  it("AJ-298: renders 建议/总结/场景·标签 as distinct paragraphs separated by blank lines", () => {
    const out = formatResult({ ...base, status: "pending" });
    const paragraphs = out.text.split("\n\n");
    expect(paragraphs[0]).toBe("<b>示例标题</b>");
    expect(paragraphs[1]).toBe("建议：保留 · 很实用");
    expect(paragraphs[2]).toBe("总结：这是一段摘要。");
    expect(paragraphs[3]).toBe("类型：技能 · 用法：直接整合 · 场景：编程、自动化 · 标签：rag、web-scraping");
  });

  it("AJ-298: shows 评分：★4/5 with the reason when the card has a score", () => {
    const out = formatResult({ ...base, status: "pending", score: 4, scoreReason: "生态成熟" });
    expect(out.text).toContain("评分：★4/5 · 生态成熟");
  });

  it("AJ-298: omits the 评分 line entirely when the card has no score (never renders ★0/5)", () => {
    const out = formatResult({ ...base, status: "pending", score: null, scoreReason: null });
    expect(out.text).not.toContain("评分");
    expect(out.text).not.toContain("★");
  });

  it("AJ-298: also omits the 评分 line when score is undefined", () => {
    const out = formatResult({ ...base, status: "pending" });
    expect(out.text).not.toContain("评分");
  });
});

describe("formatResult — failed", () => {
  it("renders a Chinese failure reason and a single rerun button, from only id/errorCode/updatedAt", () => {
    const out = formatResult({ ...failedBase, errorCode: "TIMEOUT" });
    expect(out.text).toBe("❌ 分析失败 · 模型响应超时");
    const kb = out.replyMarkup?.inline_keyboard;
    expect(kb).toHaveLength(1);
    expect(kb?.[0]).toHaveLength(1);
    expect(kb?.[0]?.[0]?.text).toBe("♻️ 重跑分析");
    expect(decodeDecision(kb![0]![0]!.callback_data!)).toEqual({ action: "rerun", capabilityId: failedBase.id, updatedAt: failedBase.updatedAt });
  });

  it("falls back to a generic message for an unrecognised error code", () => {
    const out = formatResult({ ...failedBase, errorCode: "SOMETHING_WEIRD" });
    expect(out.text).toBe("❌ 分析失败 · 分析失败（SOMETHING_WEIRD）");
  });
});

describe("formatResult — defensive message-length cap", () => {
  it("truncates the final rendered text to TELEGRAM_MESSAGE_MAX_LEN even when tags/scenarios are unbounded", () => {
    const manyTags = Array.from({ length: 2000 }, (_, i) => `标签${i}`);
    const manyScenarios = Array.from({ length: 500 }, (_, i) => `场景${i}`);
    const out = formatResult({ ...base, tags: manyTags, scenarioLabels: manyScenarios });
    expect(Array.from(out.text).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_LEN);
  });

  it("leaves a normal-sized card untouched", () => {
    const out = formatResult(base);
    expect(Array.from(out.text).length).toBeLessThan(TELEGRAM_MESSAGE_MAX_LEN);
  });

  /**
   * Regression for the bug an earlier version of this cap introduced: truncating the *already
   * assembled* HTML by raw codepoint could land mid-tag or mid-entity, producing text Telegram
   * rejects outright with a 400 "can't parse entities" — which notify.ts's permanent-4xx
   * handling would then have silently retired as delivered. Fields are now shrunk before
   * escaping/assembly instead, so the result must always stay both within the limit AND
   * well-formed (the anchor and bold tags fully intact, every `<` matched by a `>`).
   */
  it("stays within the limit AND keeps well-formed HTML (anchor intact, tags balanced) with a huge tags/scenarios set and a very long title — keep card", () => {
    const manyTags = Array.from({ length: 5000 }, (_, i) => `标签${i}`);
    const manyScenarios = Array.from({ length: 2000 }, (_, i) => `场景${i}`);
    const hugeTitle = "长".repeat(5000);
    const out = formatResult({ ...base, title: hugeTitle, tags: manyTags, scenarioLabels: manyScenarios });
    expect(Array.from(out.text).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_LEN);
    expect(out.text).toContain('<a href="https://caphub.agentjoey.ai/library/cab_deadbeefcafef00d">详情</a>');
    expect((out.text.match(/</g) ?? []).length).toBe((out.text.match(/>/g) ?? []).length);
  });

  it("stays within the limit and well-formed for a pending card with a huge summary, tags, scenarios and title", () => {
    const out = formatResult({
      ...base,
      status: "pending",
      title: "标".repeat(3000),
      summary: "字".repeat(50000),
      tags: Array.from({ length: 3000 }, (_, i) => `tag${i}`),
      scenarioLabels: Array.from({ length: 1000 }, (_, i) => `场景${i}`)
    });
    expect(Array.from(out.text).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_LEN);
    expect((out.text.match(/</g) ?? []).length).toBe((out.text.match(/>/g) ?? []).length);
    // The keep/discard/rerun buttons (fixed, id-based callback_data) are unaffected by shrinking.
    expect(out.replyMarkup?.inline_keyboard).toHaveLength(2);
  });

  it("stays within the limit and well-formed for a discard card with a huge reason and title", () => {
    const out = formatResult({ ...base, status: "discard", title: "题".repeat(4000), suggestedReason: "由".repeat(4000) });
    expect(Array.from(out.text).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_LEN);
    expect(out.text).toContain('<a href="https://caphub.agentjoey.ai/library/cab_deadbeefcafef00d">详情</a>');
    expect((out.text.match(/</g) ?? []).length).toBe((out.text.match(/>/g) ?? []).length);
  });
});

const todoBase: TodoCardInput = {
  status: "todo",
  id: "cab_deadbeefcafef00d",
  title: "示例标题",
  type: "skill",
  summary: "这是一段摘要。",
  tags: ["rag", "web-scraping"],
  scenarioLabels: ["编程", "自动化"],
  serial: 7,
  score: 4,
  scoreReason: "生态成熟",
  progress: "todo",
  updatedAt: "2026-09-20T00:00:00.000Z"
};

describe("formatResult — todo", () => {
  it("renders 总结/场景·标签/进度/评分 as paragraphs and the 开始自研/已完成/放弃/去 web buttons", () => {
    const out = formatResult(todoBase);
    const paragraphs = out.text.split("\n\n");
    expect(paragraphs[0]).toBe("<b>示例标题</b>");
    expect(paragraphs[1]).toBe("总结：这是一段摘要。");
    expect(paragraphs[2]).toBe("场景：编程、自动化 · 标签：rag、web-scraping");
    expect(paragraphs[3]).toBe("进度：未处理");
    expect(paragraphs[4]).toBe("评分：★4/5 · 生态成熟");

    const kb = out.replyMarkup?.inline_keyboard;
    expect(kb).toHaveLength(3);
    expect(kb?.[2]?.[0]?.text).toBe("🔬 深度分析");
    expect(kb?.[0]?.[0]?.text).toBe("🔨 开始自研");
    expect(kb?.[0]?.[1]?.text).toBe("✅ 已完成");
    expect(kb?.[1]?.[0]?.text).toBe("🚫 放弃");
    expect(kb?.[1]?.[1]?.text).toBe("🔗 去 web");

    expect(decodeDecision(kb![0]![0]!.callback_data!)).toEqual({ action: "progress-building", capabilityId: todoBase.id, updatedAt: todoBase.updatedAt });
    expect(decodeDecision(kb![0]![1]!.callback_data!)).toEqual({ action: "progress-done", capabilityId: todoBase.id, updatedAt: todoBase.updatedAt });
    expect(decodeDecision(kb![1]![0]!.callback_data!)).toEqual({ action: "progress-dropped", capabilityId: todoBase.id, updatedAt: todoBase.updatedAt });
    expect(kb?.[1]?.[1]?.url).toContain("/library/cab_deadbeefcafef00d");
  });

  it("keeps the four self-build buttons plus 深度分析, and no failure note, for a healthy todo card", () => {
    const out = formatResult(todoBase);
    expect(out.replyMarkup?.inline_keyboard.flat()).toHaveLength(5);
    expect(out.text).not.toContain("上次分析失败");
  });

  // Controller ruling (M3.5 walkthrough): a failed latest run is a note on the self-build card,
  // not a replacement for it — but it must still be actionable from Telegram, so the card grows
  // a fifth button reusing the normal rerun callback (a /todo card always has a capability row,
  // so it's the "rerun" action, never the capture-id "rerun-capture" variant).
  it("adds the 上次分析失败 note and a ♻️ 重跑分析 row when the latest run failed", () => {
    const out = formatResult({ ...todoBase, progress: "building", lastRunError: "INVALID_OUTPUT" });
    expect(out.text).toContain("进度：自研中");
    expect(out.text).toContain(`<i>上次分析失败：${errorLabel("INVALID_OUTPUT", "zh")}</i>`);
    expect(out.text).not.toContain("❌ 分析失败");

    const kb = out.replyMarkup?.inline_keyboard;
    expect(kb).toHaveLength(4);
    expect(kb?.flat().map((b) => b.text)).toEqual(["🔨 开始自研", "✅ 已完成", "🚫 放弃", "🔗 去 web", "♻️ 重跑分析", "🔬 深度分析"]);
    expect(decodeDecision(kb![2]![0]!.callback_data!)).toEqual({ action: "rerun", capabilityId: todoBase.id, updatedAt: todoBase.updatedAt });
  });

  it("notes a failed latest run with no error code without an empty reason", () => {
    const out = formatResult({ ...todoBase, lastRunError: null });
    expect(out.text).toContain("<i>上次分析失败</i>");
    expect(out.replyMarkup?.inline_keyboard.flat()).toHaveLength(6);
  });

  it("omits the 评分 line when the card has no score", () => {
    const out = formatResult({ ...todoBase, score: null, scoreReason: null });
    expect(out.text).not.toContain("评分");
  });

  it("shows the current progress label", () => {
    const out = formatResult({ ...todoBase, progress: "building" });
    expect(out.text).toContain("进度：自研中");
  });
});

describe("formatDeepSummary", () => {
  const analysis = {
    headline: "自托管的浏览器自动化框架",
    architecture: { summary: "三层", points: ["a", "b", "c"] },
    implementation: { summary: "Python", points: ["a", "b", "c"] },
    use_cases: [{ title: "批量抓取", detail: "定时抓取" }, { title: "b", detail: "d" }, { title: "c", detail: "e" }],
    cases: [],
    feedback: { positive: [], negative: [] },
    risks: ["依赖上游浏览器版本", "内存吃紧"],
    sources: [{ title: "文档", url: "https://example.com" }]
  } satisfies DeepAnalysis;

  it("pushes only the headline, best-fit scenario, top risk and a link — never the whole analysis", () => {
    const out = formatDeepSummary({ id: "cab_deadbeefcafef00d", title: "示例标题", analysis });
    const lines = out.text.split("\n");
    expect(lines[0]).toBe("🔬 深度分析完成");
    expect(lines[1]).toBe("<b>示例标题</b>");
    expect(lines[2]).toBe("自托管的浏览器自动化框架");
    expect(lines[3]).toBe("最适合场景：批量抓取");
    expect(lines[4]).toBe("最大风险：依赖上游浏览器版本");
    expect(lines[5]).toContain("查看完整分析");
    expect(lines).toHaveLength(6);
    // The six-section detail stays on the web.
    expect(out.text).not.toContain("三层");
    expect(out.text).not.toContain("架构");
    expect(out.replyMarkup).toBeUndefined();
  });

  it("reports a failed deep run with its reason instead of an empty summary", () => {
    const out = formatDeepSummary({ id: "cab_1", title: "示例标题", analysis: null, errorCode: "TIMEOUT" });
    expect(out.text).toContain(`🔬 深度分析失败 · ${errorLabel("TIMEOUT", "zh")}`);
    expect(out.text).toContain("<b>示例标题</b>");
  });

  it("escapes card- and model-derived text and never renders the internal id as text", () => {
    const out = formatDeepSummary({ id: "cab_deadbeefcafef00d", title: "<script>", analysis: { ...analysis, headline: "a & b" } });
    expect(out.text).toContain("&lt;script&gt;");
    expect(out.text).toContain("a &amp; b");
    expect(out.text.replace(/https:\/\/\S+/g, "")).not.toContain("cab_deadbeefcafef00d");
  });

  it("drops the scenario/risk lines when the stored blob has none", () => {
    const out = formatDeepSummary({ id: "cab_1", title: "示例标题", analysis: { ...analysis, use_cases: [], risks: [] } as unknown as DeepAnalysis });
    expect(out.text).not.toContain("最适合场景");
    expect(out.text).not.toContain("最大风险");
    expect(out.text).toContain("自托管的浏览器自动化框架");
  });
});

describe("formatResult — summary points (M3.8)", () => {
  const points = [
    { label: "定位", text: "自适应反爬抓取库" },
    { label: "适用", text: "结构常变的站点" },
    { label: "限制", text: "不处理登录态" }
  ];

  it("renders each point as its own <b>标签。</b> 说明 line, in one paragraph after 总结 — pending card", () => {
    const out = formatResult({ ...base, status: "pending", summaryPoints: points });
    const paragraphs = out.text.split("\n\n");
    expect(paragraphs[2]).toBe("总结：这是一段摘要。");
    expect(paragraphs[3]).toBe("<b>定位。</b> 自适应反爬抓取库\n<b>适用。</b> 结构常变的站点\n<b>限制。</b> 不处理登录态");
  });

  it("omits the points paragraph entirely for a card that has none yet — the prose 总结 stands alone", () => {
    const out = formatResult({ ...base, status: "pending", summaryPoints: [] });
    const paragraphs = out.text.split("\n\n");
    expect(paragraphs[2]).toBe("总结：这是一段摘要。");
    expect(paragraphs[3]).toBe("类型：技能 · 用法：直接整合 · 场景：编程、自动化 · 标签：rag、web-scraping");
    expect(out.text).not.toContain("<b>定位");
  });

  it("treats an absent summaryPoints field as no points", () => {
    const out = formatResult({ ...base, status: "pending" });
    expect(out.text.split("\n\n")[3]).toContain("类型：技能");
  });

  it("escapes a point's label and text", () => {
    const out = formatResult({
      ...base,
      status: "pending",
      summaryPoints: [{ label: "<b>x", text: "a & <script>" }]
    });
    expect(out.text).toContain("<b>&lt;b&gt;x。</b> a &amp; &lt;script&gt;");
  });

  it("drops malformed points (non-string label/text, or a non-object entry) instead of throwing", () => {
    const malformed = [
      { label: "定位", text: "自适应反爬抓取库" },
      { label: 42, text: "数字标签" },
      { label: "缺文字" },
      null,
      "not an object",
      { label: "限制", text: null }
    ] as never;
    const out = formatResult({ ...base, status: "pending", summaryPoints: malformed });
    expect(out.text).toContain("<b>定位。</b> 自适应反爬抓取库\n数字标签");
    expect(out.text).not.toContain("缺文字");
    expect(out.text).not.toContain("限制");
  });

  it("renders the points on a todo card too", () => {
    const out = formatResult({ ...todoBase, summaryPoints: points });
    expect(out.text).toContain("<b>定位。</b> 自适应反爬抓取库");
  });

  it("stays within the limit and well-formed when the points themselves are huge — points are dropped whole, markup never cut", () => {
    const out = formatResult({
      ...base,
      status: "pending",
      summary: "字".repeat(300),
      summaryPoints: Array.from({ length: 200 }, (_, i) => ({ label: `标签${i}`, text: "说".repeat(200) }))
    });
    expect(Array.from(out.text).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_LEN);
    expect((out.text.match(/</g) ?? []).length).toBe((out.text.match(/>/g) ?? []).length);
    expect((out.text.match(/<b>/g) ?? []).length).toBe((out.text.match(/<\/b>/g) ?? []).length);
    // The card's own lines survive: shrinking drops points, it does not eat the 建议/总结 text.
    expect(out.text).toContain("建议：保留 · 很实用");
  });

  it("keeps the tags line when the points are what pushed the card over the limit", () => {
    const out = formatResult({
      ...base,
      status: "pending",
      summaryPoints: Array.from({ length: 100 }, (_, i) => ({ label: `标签${i}`, text: "说".repeat(100) }))
    });
    expect(Array.from(out.text).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_LEN);
    expect(out.text).toContain("标签：rag、web-scraping");
  });
});
