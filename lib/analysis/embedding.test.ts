import { describe, expect, it } from "vitest";
import { embeddingText, toVectorLiteral } from "./embedding";

describe("embeddingText", () => {
  it("joins title, summary, tags and scenario labels deterministically", () => {
    const text = embeddingText({ title: "T", summary: "S", tags: ["a", "b"], scenarioLabels: ["视频", "Video"], summaryPoints: [] });
    expect(text).toBe("T\nS\n标签: a, b\n场景: 视频, Video");
  });

  it("omits the tags line when there are no tags", () => {
    const text = embeddingText({ title: "T", summary: "S", tags: [], scenarioLabels: ["视频", "Video"], summaryPoints: [] });
    expect(text).toBe("T\nS\n场景: 视频, Video");
  });

  it("omits the scenario line when there are no scenario labels", () => {
    const text = embeddingText({ title: "T", summary: "S", tags: ["a"], scenarioLabels: [], summaryPoints: [] });
    expect(text).toBe("T\nS\n标签: a");
  });

  it("is deterministic across repeated calls with the same input", () => {
    const row = { title: "T", summary: "S", tags: ["a", "b"], scenarioLabels: ["视频", "Video"], summaryPoints: [] };
    expect(embeddingText(row)).toBe(embeddingText({ ...row }));
  });

  it("includes summary_points' labels and text, between the summary and the tags", () => {
    const text = embeddingText({
      title: "T", summary: "S", tags: ["a"], scenarioLabels: [],
      summaryPoints: [{ label: "定位", text: "一句话定位" }, { label: "场景", text: "适用场景说明" }]
    });
    expect(text).toBe("T\nS\n定位: 一句话定位; 场景: 适用场景说明\n标签: a");
  });

  it("omits the summary_points line when there are none", () => {
    const text = embeddingText({ title: "T", summary: "S", tags: [], scenarioLabels: [], summaryPoints: [] });
    expect(text).toBe("T\nS");
  });

  it("lets search find a word that only appears in a point's text, not in the (now short) summary", () => {
    const text = embeddingText({
      title: "T", summary: "简短摘要", tags: [], scenarioLabels: [],
      summaryPoints: [{ label: "限制", text: "仅支持自建 Neon 数据库" }]
    });
    expect(text).toContain("Neon");
  });
});

describe("toVectorLiteral", () => {
  it("formats a number array as a pgvector text literal", () => {
    expect(toVectorLiteral([0.1, 0.2, -0.3])).toBe("[0.1,0.2,-0.3]");
  });

  it("formats an empty array", () => {
    expect(toVectorLiteral([])).toBe("[]");
  });
});
