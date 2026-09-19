import { describe, expect, it } from "vitest";
import { matchScenarios } from "./scenario-match";

const SCENARIOS = [
  { slug: "video", labelZh: "视频", labelEn: "Video", keywords: ["剪辑", "配音", "字幕", "video", "editing"] },
  { slug: "coding", labelZh: "编程", labelEn: "Coding", keywords: ["开发", "代码", "调试", "code"] }
];

describe("matchScenarios", () => {
  it("matches on exact slug (case-insensitive)", () => {
    expect(matchScenarios("Video", SCENARIOS)).toEqual(["video"]);
  });

  it("matches on exact zh label", () => {
    expect(matchScenarios("视频", SCENARIOS)).toEqual(["video"]);
  });

  it("matches on exact en label", () => {
    expect(matchScenarios("coding", SCENARIOS)).toEqual(["coding"]);
  });

  it("matches on exact keyword", () => {
    expect(matchScenarios("剪辑", SCENARIOS)).toEqual(["video"]);
  });

  it("matches when the query contains the zh label", () => {
    expect(matchScenarios("推荐一些视频工具", SCENARIOS)).toEqual(["video"]);
  });

  it("matches when the query contains a keyword of length >= 2", () => {
    expect(matchScenarios("怎么做字幕", SCENARIOS)).toEqual(["video"]);
  });

  it("matches when the zh label contains the (short) query", () => {
    expect(matchScenarios("频", SCENARIOS)).toEqual(["video"]);
  });

  it("returns multiple matched slugs", () => {
    expect(matchScenarios("视频 代码", SCENARIOS).sort()).toEqual(["coding", "video"]);
  });

  it("returns empty for no match", () => {
    expect(matchScenarios("完全不相关的词", SCENARIOS)).toEqual([]);
  });

  it("returns empty for an empty/blank query", () => {
    expect(matchScenarios("   ", SCENARIOS)).toEqual([]);
  });

  it("matches an ASCII keyword as a whole word (positive control for the false-positive tests below)", () => {
    expect(matchScenarios("video editing tips", SCENARIOS)).toEqual(["video"]);
  });

  it("does not false-positive on a short ASCII keyword found only as a substring of a longer word", () => {
    const scenarios = [
      { slug: "design", labelZh: "设计", labelEn: "Design", keywords: ["ux", "ui", "figma"] },
      { slug: "marketing", labelZh: "营销", labelEn: "Marketing", keywords: ["ads", "seo"] },
      { slug: "coding", labelZh: "编程", labelEn: "Coding", keywords: ["code", "debug"] }
    ];
    expect(matchScenarios("linux", scenarios)).toEqual([]);
    expect(matchScenarios("a guide to backups", scenarios)).toEqual([]);
    expect(matchScenarios("how to build this", scenarios)).toEqual([]);
    expect(matchScenarios("threads app", scenarios)).toEqual([]);
    expect(matchScenarios("downloads folder", scenarios)).toEqual([]);
    expect(matchScenarios("vscode extensions", scenarios)).toEqual([]);
  });

  it("still matches a short ASCII keyword as its own whole word", () => {
    const scenarios = [{ slug: "design", labelZh: "设计", labelEn: "Design", keywords: ["ux", "ui"] }];
    expect(matchScenarios("improve the ux of this app", scenarios)).toEqual(["design"]);
    expect(matchScenarios("ui review needed", scenarios)).toEqual(["design"]);
  });

  it("keeps plain substring matching for CJK keywords/labels", () => {
    expect(matchScenarios("视频剪辑软件推荐", SCENARIOS)).toEqual(["video"]);
  });
});
