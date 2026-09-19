import { describe, expect, it } from "vitest";
import { RESERVED_TAGS } from "./card";
import { reasonPrompt } from "./prompts";

const material = { kind: "text" as const, text: "hello" };

describe("reasonPrompt", () => {
  it("instructs tags to be lowercase English words or hyphenated phrases, never Chinese or reserved words", () => {
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar: [], existingTags: [] });
    expect(prompt).toContain("web-scraping");
    expect(prompt).toContain("不能是中文");
    for (const word of RESERVED_TAGS) expect(prompt).toContain(word);
  });

  it("tells the model to reuse an existing tag when one fits", () => {
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar: [], existingTags: ["rag"] });
    expect(prompt).toContain("rag");
    expect(prompt).toMatch(/复用/);
  });
});
