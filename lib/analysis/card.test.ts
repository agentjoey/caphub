import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cardSchema } from "./card";

const valid = {
  title: "用 Playwright 生成 axe 可访问性报告", type: "skill", summary: "一段摘要",
  signals: ["解决 CI 里可访问性回归", "与库里已有 e2e-a11y 重叠"],
  suggested_verdict: "keep", suggested_reason: "有可执行命令", confidence: 0.9,
  usage: "integrate", playbook: { kind: "integrate", install: ["npm i -D @axe-core/playwright"], repo: null, prompt_text: null },
  tags: ["testing", "accessibility"], source_url: null
};

describe("cardSchema", () => {
  it("accepts a valid card", () => { expect(cardSchema.parse(valid)).toEqual(valid); });
  it("lowercases tags and rejects >6", () => {
    expect(cardSchema.parse({ ...valid, tags: ["Testing"] }).tags).toEqual(["testing"]);
    expect(() => cardSchema.parse({ ...valid, tags: ["a","b","c","d","e","f","g"] })).toThrow();
  });
  it("trims, lowercases, drops empty and dedupes tags before counting", () => {
    expect(cardSchema.parse({ ...valid, tags: ["RAG", "rag ", " ", "Agents"] }).tags).toEqual(["rag", "agents"]);
    expect(cardSchema.parse({ ...valid, tags: ["a", "A", "b", "c", "d", "e", "f"] }).tags).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(() => cardSchema.parse({ ...valid, tags: [" ", ""] })).toThrow();
  });
  it("stays representable as JSON Schema for providers", () => {
    expect(z.toJSONSchema(cardSchema).properties?.tags).toMatchObject({ type: "array", minItems: 1, maxItems: 6 });
  });
  it("requires experience playbook for experience type", () => {
    expect(() => cardSchema.parse({ ...valid, type: "experience" })).toThrow(/experience/);
  });
  it("requires 2-3 signals", () => {
    expect(() => cardSchema.parse({ ...valid, signals: ["one"] })).toThrow();
  });
  it("enforces usage ↔ playbook.kind for non-experience types", () => {
    expect(() => cardSchema.parse({
      ...valid,
      usage: "integrate",
      playbook: { kind: "reference", points: ["a"] }
    })).toThrow(/integrate/);
  });
  it("allows usage reference with reference playbook (type skill)", () => {
    expect(cardSchema.parse({
      ...valid,
      usage: "reference",
      playbook: { kind: "reference", points: ["point 1"] }
    }).usage).toBe("reference");
  });
  it("allows experience type with usage reference", () => {
    expect(cardSchema.parse({
      ...valid,
      type: "experience",
      usage: "reference",
      playbook: { kind: "experience", content: "test content", when_to_use: "test when" }
    }).usage).toBe("reference");
  });
  it("allows repo as owner/repo format in integrate playbook", () => {
    expect(cardSchema.parse({
      ...valid,
      playbook: { kind: "integrate", install: ["npm i"], repo: "owner/repo", prompt_text: null }
    }).playbook).toMatchObject({ kind: "integrate", repo: "owner/repo" });
  });
});
