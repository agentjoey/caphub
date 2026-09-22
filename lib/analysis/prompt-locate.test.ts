import { describe, expect, it } from "vitest";
import { collectPrompts, locatePrompts } from "./prompt-locate";

const SOURCE = [
  "今天分享两条提示词。",
  "第一条：",
  "你是一个信息整理助手。给定多篇来源文本，输出：",
  "1) 一句话标题；2) 3-5 条要点。不要编造。",
  "第二条：",
  "Act as a senior reviewer.  List risks first, then fixes.",
  "完。"
].join("\n");

describe("locatePrompts", () => {
  it("slices each prompt verbatim from the source, keeping line breaks", () => {
    const out = locatePrompts(SOURCE, [
      { start: "你是一个信息整理助手", end: "3-5 条要点。不要编造。" },
      { start: "Act as a senior", end: "then fixes." }
    ]);
    expect(out.unresolved).toBe(0);
    expect(out.prompts).toEqual([
      "你是一个信息整理助手。给定多篇来源文本，输出：\n1) 一句话标题；2) 3-5 条要点。不要编造。",
      "Act as a senior reviewer.  List risks first, then fixes."
    ]);
  });

  it("matches anchors whose whitespace the model normalised, but stores the source's own whitespace", () => {
    const out = locatePrompts(SOURCE, [{ start: "输出： 1) 一句话", end: "reviewer. List risks" }]);
    expect(out.prompts[0]).toContain("输出：\n1) 一句话");
    expect(out.prompts[0]).toContain("reviewer.  List risks");
  });

  it("counts an anchor that is not in the source as unresolved and drops it", () => {
    const out = locatePrompts(SOURCE, [{ start: "你是一个信息整理助手", end: "不存在的结尾" }, { start: "Act as", end: "fixes." }]);
    expect(out.unresolved).toBe(1);
    expect(out.prompts).toEqual(["Act as a senior reviewer.  List risks first, then fixes."]);
  });

  it("finds repeated anchors in order rather than reusing the first hit", () => {
    const src = "A: 请回答。\nB: 请回答。";
    const out = locatePrompts(src, [{ start: "请回答", end: "请回答。" }, { start: "请回答", end: "请回答。" }]);
    expect(out.prompts).toEqual(["请回答。", "请回答。"]);
    expect(out.unresolved).toBe(0);
  });

  it("handles a prompt shorter than its two anchors combined", () => {
    expect(locatePrompts("前言 做个按钮 后记", [{ start: "做个按钮", end: "做个按钮" }]).prompts).toEqual(["做个按钮"]);
  });

  it("drops (never truncates) a located prompt over MAX_PROMPT_CHARS", () => {
    const long = "开头" + "字".repeat(20_000) + "结尾";
    const out = locatePrompts(long, [{ start: "开头", end: "结尾" }]);
    expect(out.prompts).toEqual([]);
    expect(out.unresolved).toBe(1);
  });

  it("ignores locators beyond MAX_PROMPTS and counts them unresolved", () => {
    const src = Array.from({ length: 22 }, (_, i) => `P${i}x`).join(" ");
    const locators = Array.from({ length: 22 }, (_, i) => ({ start: `P${i}x`, end: `P${i}x` }));
    const out = locatePrompts(src, locators);
    expect(out.prompts).toHaveLength(20);
    expect(out.unresolved).toBe(2);
  });
});

describe("collectPrompts", () => {
  const extraction = { what: "w", visible_text: "", commands: [], prompts: ["图里的原文"], source_hints: [], questions: [] };

  it("uses the vision transcription for an image and ignores locators", () => {
    const out = collectPrompts({ material: { kind: "image", png: new Uint8Array(), ocrText: "", width: 1, height: 1 }, extraction, locators: [{ start: "x", end: "y" }] });
    expect(out).toEqual({ prompts: ["图里的原文"], unresolved: 0 });
  });

  it("drops blank transcriptions for an image", () => {
    const out = collectPrompts({ material: { kind: "image", png: new Uint8Array(), ocrText: "", width: 1, height: 1 }, extraction: { ...extraction, prompts: ["  ", "ok"] }, locators: [] });
    expect(out.prompts).toEqual(["ok"]);
  });

  it("locates against the text capture", () => {
    const out = collectPrompts({ material: { kind: "text", text: SOURCE }, extraction: null, locators: [{ start: "Act as", end: "fixes." }] });
    expect(out.prompts).toEqual(["Act as a senior reviewer.  List risks first, then fixes."]);
  });

  it("counts every locator unresolved when the page text could not be fetched", () => {
    const out = collectPrompts({ material: { kind: "url", url: "https://a.b", text: null }, extraction: null, locators: [{ start: "a", end: "b" }] });
    expect(out).toEqual({ prompts: [], unresolved: 1 });
  });
});
