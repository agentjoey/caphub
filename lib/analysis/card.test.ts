import { describe, expect, it } from "vitest";
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
  it("requires experience playbook for experience type", () => {
    expect(() => cardSchema.parse({ ...valid, type: "experience" })).toThrow(/experience/);
  });
  it("requires 2-3 signals", () => {
    expect(() => cardSchema.parse({ ...valid, signals: ["one"] })).toThrow();
  });
});
