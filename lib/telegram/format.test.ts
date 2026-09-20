import { describe, expect, it } from "vitest";
import { decodeDecision } from "./router";
import { formatResult, TELEGRAM_MESSAGE_MAX_LEN, type DecidedCardInput, type FailedCardInput } from "./format";

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
  it("renders the serial, title, meta, scenarios, tags and a web link; no buttons", () => {
    const out = formatResult(base);
    expect(out.text).toContain("✅ 已保留 · SKL-0007");
    expect(out.text).toContain("<b>示例标题</b>");
    expect(out.text).toContain("类型：技能 · 用法：直接整合");
    expect(out.text).toContain("场景：编程、自动化");
    expect(out.text).toContain("标签：rag、web-scraping");
    expect(out.text).toContain("/library/cab_deadbeefcafef00d");
    expect(out.replyMarkup).toBeUndefined();
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
});

describe("formatResult — pending", () => {
  it("renders title, suggestion+reason, truncated summary, meta and four buttons two-per-row", () => {
    const longSummary = "字".repeat(400);
    const out = formatResult({ ...base, status: "pending", summary: longSummary });
    expect(out.text).toContain("<b>示例标题</b>");
    expect(out.text).toContain("建议：保留 · 很实用");
    expect(out.text).toContain("字".repeat(300));
    expect(out.text).not.toContain("字".repeat(301));
    expect(out.text).not.toContain("SKL-");

    const kb = out.replyMarkup?.inline_keyboard;
    expect(kb).toHaveLength(2);
    expect(kb?.[0]).toHaveLength(2);
    expect(kb?.[1]).toHaveLength(2);
    expect(kb?.[0]?.[0]?.text).toBe("保留");
    expect(kb?.[0]?.[1]?.text).toBe("丢弃");
    expect(kb?.[1]?.[0]?.text).toBe("重跑分析");
    expect(kb?.[1]?.[1]?.text).toBe("去 web");

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
});

describe("formatResult — failed", () => {
  it("renders a Chinese failure reason and a single rerun button, from only id/errorCode/updatedAt", () => {
    const out = formatResult({ ...failedBase, errorCode: "TIMEOUT" });
    expect(out.text).toBe("❌ 分析失败 · 模型响应超时");
    const kb = out.replyMarkup?.inline_keyboard;
    expect(kb).toHaveLength(1);
    expect(kb?.[0]).toHaveLength(1);
    expect(kb?.[0]?.[0]?.text).toBe("重跑");
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
