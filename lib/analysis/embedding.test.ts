import { describe, expect, it } from "vitest";
import { embeddingText, toVectorLiteral } from "./embedding";

describe("embeddingText", () => {
  it("joins title, summary, tags and scenario labels deterministically", () => {
    const text = embeddingText({ title: "T", summary: "S", tags: ["a", "b"], scenarioLabels: ["视频", "Video"] });
    expect(text).toBe("T\nS\n标签: a, b\n场景: 视频, Video");
  });

  it("omits the tags line when there are no tags", () => {
    const text = embeddingText({ title: "T", summary: "S", tags: [], scenarioLabels: ["视频", "Video"] });
    expect(text).toBe("T\nS\n场景: 视频, Video");
  });

  it("omits the scenario line when there are no scenario labels", () => {
    const text = embeddingText({ title: "T", summary: "S", tags: ["a"], scenarioLabels: [] });
    expect(text).toBe("T\nS\n标签: a");
  });

  it("is deterministic across repeated calls with the same input", () => {
    const row = { title: "T", summary: "S", tags: ["a", "b"], scenarioLabels: ["视频", "Video"] };
    expect(embeddingText(row)).toBe(embeddingText({ ...row }));
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
