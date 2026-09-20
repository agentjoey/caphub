import { describe, expect, it } from "vitest";
import { RESERVED_TAGS } from "./card";
import { backfillScorePrompt, reasonPrompt } from "./prompts";

const material = { kind: "text" as const, text: "hello" };
const scenarios = [
  { slug: "coding", labelZh: "编程", labelEn: "Coding", keywords: ["开发", "代码"] },
  { slug: "writing", labelZh: "写作", labelEn: "Writing", keywords: ["文案"] }
];

describe("reasonPrompt", () => {
  it("instructs tags to be lowercase English words or hyphenated phrases, never Chinese or reserved words", () => {
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar: [], existingTags: [], scenarios });
    expect(prompt).toContain("web-scraping");
    expect(prompt).toContain("不能是中文");
    for (const word of RESERVED_TAGS) expect(prompt).toContain(word);
  });

  it("tells the model to reuse an existing tag when one fits", () => {
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar: [], existingTags: ["rag"], scenarios });
    expect(prompt).toContain("rag");
    expect(prompt).toMatch(/复用/);
  });

  it("lists candidate scenarios as slug（中文名：关键词…） and asks for 1–3 fitting ones", () => {
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar: [], existingTags: [], scenarios });
    expect(prompt).toContain("coding（编程：开发、代码）");
    expect(prompt).toContain("writing（写作：文案）");
    expect(prompt).toMatch(/1–3 个/);
  });

  it("gives the scoring rubric (maturity, reproducibility, fit, complementarity) and the 1-5/4-5/1-2 guidance", () => {
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar: [], existingTags: [], scenarios });
    expect(prompt).toMatch(/成熟度/);
    expect(prompt).toMatch(/可复现性/);
    expect(prompt).toMatch(/适用度/);
    expect(prompt).toMatch(/互补性/);
    expect(prompt).toMatch(/4[–-]5 分/);
    expect(prompt).toMatch(/1[–-]2 分/);
  });

  it("forbids guessing source facts: only fill a field the sources explicitly state", () => {
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar: [], existingTags: [], scenarios });
    expect(prompt).toMatch(/source_facts/);
    expect(prompt).toMatch(/禁止推测/);
    expect(prompt).toMatch(/star/i);
    expect(prompt).toMatch(/更新时间|last_update/);
  });
});

const cardInput = {
  title: "用 Playwright 生成 axe 可访问性报告",
  summary: "一段摘要",
  signals: ["解决 CI 里可访问性回归"],
  playbook: { kind: "integrate", install: ["npm i -D @axe-core/playwright"], repo: "https://github.com/a/b", prompt_text: null },
  tags: ["testing", "accessibility"],
  source_url: "https://github.com/a/b"
};

describe("backfillScorePrompt", () => {
  it("gives the same scoring rubric as reasonPrompt", () => {
    const prompt = backfillScorePrompt(cardInput);
    expect(prompt).toMatch(/成熟度/);
    expect(prompt).toMatch(/可复现性/);
    expect(prompt).toMatch(/适用度/);
    expect(prompt).toMatch(/互补性/);
    expect(prompt).toMatch(/4[–-]5 分/);
    expect(prompt).toMatch(/1[–-]2 分/);
  });

  it("includes the card's own fields, not a web source list", () => {
    const prompt = backfillScorePrompt(cardInput);
    expect(prompt).toContain(cardInput.title);
    expect(prompt).toContain(cardInput.summary);
    expect(prompt).toContain("accessibility");
    expect(prompt).toContain("https://github.com/a/b");
    expect(prompt).not.toMatch(/联网来源/);
  });

  it("says explicitly there is no new search, and only source_url/playbook may fill repo_url", () => {
    const prompt = backfillScorePrompt(cardInput);
    expect(prompt).toMatch(/没有.*联网搜索/);
    expect(prompt).toMatch(/禁止推测/);
    expect(prompt).toMatch(/star/i);
  });

  it("handles a card with no source_url, empty signals and tags", () => {
    const prompt = backfillScorePrompt({ ...cardInput, source_url: null, signals: [], tags: [] });
    expect(prompt).toContain("（无）");
  });
});
