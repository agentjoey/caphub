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
});
