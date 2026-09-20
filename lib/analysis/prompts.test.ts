import { describe, expect, it } from "vitest";
import { RESERVED_TAGS } from "./card";
import { reasonPrompt } from "./prompts";

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
