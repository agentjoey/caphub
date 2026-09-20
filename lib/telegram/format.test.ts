import { describe, expect, it } from "vitest";
import { decodeDecision } from "./router";
import { formatResult, type DecidedCardInput, type FailedCardInput } from "./format";

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
