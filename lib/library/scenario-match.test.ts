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
});
