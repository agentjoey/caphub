import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cardSchema, finalizeSourceFacts, isValidTag, scoreResultSchema } from "./card";

const valid = {
  title: "用 Playwright 生成 axe 可访问性报告", type: "skill", summary: "一段摘要",
  signals: ["解决 CI 里可访问性回归", "与库里已有 e2e-a11y 重叠"],
  suggested_verdict: "keep", suggested_reason: "有可执行命令", confidence: 0.9,
  usage: "integrate", playbook: { kind: "integrate", install: ["npm i -D @axe-core/playwright"], repo: null, prompt_text: null },
  tags: ["testing", "accessibility"], source_url: null, scenarios: [],
  score: 4, score_reason: "有仓库和安装命令，可复现性高", source_facts: {},
  overlap: { relation: "none", target: null, reason: "" }
};

describe("isValidTag", () => {
  it("accepts valid lowercase alphanumeric tags", () => {
    expect(isValidTag("rag")).toBe(true);
    expect(isValidTag("webdev")).toBe(true);
  });

  it("accepts valid hyphenated tags", () => {
    expect(isValidTag("web-scraping")).toBe(true);
    expect(isValidTag("ai-agents")).toBe(true);
  });

  it("rejects tags with spaces", () => {
    expect(isValidTag("Web Scraping")).toBe(false);
  });

  it("rejects Chinese tags", () => {
    expect(isValidTag("金融预测")).toBe(false);
  });

  it("rejects reserved type words", () => {
    expect(isValidTag("skill")).toBe(false);
    expect(isValidTag("experience")).toBe(false);
    expect(isValidTag("plugin")).toBe(false);
  });

  it("rejects reserved playbook words", () => {
    expect(isValidTag("integrate")).toBe(false);
    expect(isValidTag("reference")).toBe(false);
  });
});

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
  it("rejects a Chinese tag", () => {
    expect(() => cardSchema.parse({ ...valid, tags: ["网页抓取"] })).toThrow();
  });
  it("rejects a tag with a space", () => {
    expect(() => cardSchema.parse({ ...valid, tags: ["Web Scraping"] })).toThrow();
  });
  it("accepts a hyphenated lowercase tag", () => {
    expect(cardSchema.parse({ ...valid, tags: ["web-scraping"] }).tags).toEqual(["web-scraping"]);
  });
  it("rejects a reserved type/usage word as a tag", () => {
    expect(() => cardSchema.parse({ ...valid, tags: ["skill"] })).toThrow();
    expect(() => cardSchema.parse({ ...valid, tags: ["integrate"] })).toThrow();
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
  it("defaults scenarios to [] when omitted", () => {
    expect(cardSchema.parse(valid).scenarios).toEqual([]);
  });
  it("accepts slug-shaped scenario strings and rejects malformed ones", () => {
    expect(cardSchema.parse({ ...valid, scenarios: ["coding", "web-scraping"] }).scenarios).toEqual(["coding", "web-scraping"]);
    expect(() => cardSchema.parse({ ...valid, scenarios: ["Not Valid"] })).toThrow();
    expect(() => cardSchema.parse({ ...valid, scenarios: ["a", "b", "c", "d"] })).toThrow();
  });
  it("allows repo as owner/repo format in integrate playbook", () => {
    expect(cardSchema.parse({
      ...valid,
      playbook: { kind: "integrate", install: ["npm i"], repo: "owner/repo", prompt_text: null }
    }).playbook).toMatchObject({ kind: "integrate", repo: "owner/repo" });
  });

  describe("score / score_reason / source_facts", () => {
    it("accepts a score of 1 through 5", () => {
      for (const score of [1, 2, 3, 4, 5]) expect(cardSchema.parse({ ...valid, score }).score).toBe(score);
    });
    it("rejects a score of 0 or 6", () => {
      expect(() => cardSchema.parse({ ...valid, score: 0 })).toThrow();
      expect(() => cardSchema.parse({ ...valid, score: 6 })).toThrow();
    });
    it("rejects a non-integer score", () => {
      expect(() => cardSchema.parse({ ...valid, score: 3.5 })).toThrow();
    });
    it("requires score and score_reason (missing fields fail)", () => {
      const { score: _score, ...withoutScore } = valid as typeof valid & { score: number };
      expect(() => cardSchema.parse(withoutScore)).toThrow();
      const { score_reason: _reason, ...withoutReason } = valid as typeof valid & { score_reason: string };
      expect(() => cardSchema.parse(withoutReason)).toThrow();
    });
    it("rejects a score_reason over 80 chars", () => {
      expect(() => cardSchema.parse({ ...valid, score_reason: "a".repeat(81) })).toThrow();
    });
    it("defaults source_facts to {} when omitted, and accepts an explicit empty object", () => {
      const { source_facts: _sf, ...withoutSourceFacts } = valid as typeof valid & { source_facts: object };
      expect(cardSchema.parse(withoutSourceFacts).source_facts).toEqual({});
      expect(cardSchema.parse({ ...valid, source_facts: {} }).source_facts).toEqual({});
    });
    it("accepts a fully-populated source_facts object", () => {
      const source_facts = {
        repo_url: "https://github.com/a/b", stars: 123, last_update: "2026-01-15",
        license: "MIT", homepage: "https://example.com", as_of: "2026-09-20"
      };
      expect(cardSchema.parse({ ...valid, source_facts }).source_facts).toEqual(source_facts);
    });
    it("accepts explicit nulls for every source_facts field", () => {
      const source_facts = { repo_url: null, stars: null, last_update: null, license: null, homepage: null, as_of: null };
      expect(cardSchema.parse({ ...valid, source_facts }).source_facts).toEqual(source_facts);
    });
    it("rejects a non-ISO-date last_update or as_of", () => {
      expect(() => cardSchema.parse({ ...valid, source_facts: { last_update: "yesterday" } })).toThrow();
      expect(() => cardSchema.parse({ ...valid, source_facts: { as_of: "not-a-date" } })).toThrow();
    });
    it("rejects a negative or non-integer stars count", () => {
      expect(() => cardSchema.parse({ ...valid, source_facts: { stars: -1 } })).toThrow();
      expect(() => cardSchema.parse({ ...valid, source_facts: { stars: 1.5 } })).toThrow();
    });
    it("stays representable as JSON Schema for providers", () => {
      const jsonSchema = z.toJSONSchema(cardSchema) as { properties?: Record<string, unknown> };
      expect(jsonSchema.properties?.score).toMatchObject({ type: "integer", minimum: 1, maximum: 5 });
      expect(jsonSchema.properties?.score_reason).toMatchObject({ type: "string", maxLength: 80 });
      expect(jsonSchema.properties?.source_facts).toMatchObject({ type: "object" });
    });
  });
});

describe("cardSchema overlap", () => {
  it("defaults overlap to none/null/empty-reason when omitted", () => {
    expect(cardSchema.parse(valid).overlap).toEqual({ relation: "none", target: null, reason: "" });
  });
  it("accepts an explicit none overlap with a null target", () => {
    const overlap = { relation: "none", target: null, reason: "库里没有相似能力" };
    expect(cardSchema.parse({ ...valid, overlap }).overlap).toEqual(overlap);
  });
  it("accepts each non-none relation paired with a non-null target", () => {
    for (const relation of ["duplicate", "upgrade", "superseded", "complement"] as const) {
      const overlap = { relation, target: "TOL-0009", reason: "理由" };
      expect(cardSchema.parse({ ...valid, overlap }).overlap).toEqual(overlap);
    }
  });
  it("rejects relation 'none' paired with a non-null target", () => {
    expect(() => cardSchema.parse({ ...valid, overlap: { relation: "none", target: "TOL-0009", reason: "r" } })).toThrow(/target/);
  });
  it("rejects a non-none relation paired with a null target", () => {
    expect(() => cardSchema.parse({ ...valid, overlap: { relation: "duplicate", target: null, reason: "r" } })).toThrow(/target/);
  });
  it("rejects an unknown relation value", () => {
    expect(() => cardSchema.parse({ ...valid, overlap: { relation: "unrelated", target: null, reason: "r" } })).toThrow();
  });
  it("rejects an overlap reason over 80 chars", () => {
    expect(() => cardSchema.parse({ ...valid, overlap: { relation: "duplicate", target: "TOL-0009", reason: "a".repeat(81) } })).toThrow();
  });
  it("stays representable as JSON Schema for providers", () => {
    const jsonSchema = z.toJSONSchema(cardSchema) as { properties?: Record<string, unknown> };
    expect(jsonSchema.properties?.overlap).toMatchObject({ type: "object" });
  });
});

describe("scoreResultSchema", () => {
  it("accepts just score/score_reason/source_facts, without the rest of the card", () => {
    const parsed = scoreResultSchema.parse({ score: 4, score_reason: "有仓库和安装命令", source_facts: {} });
    expect(parsed).toEqual({ score: 4, score_reason: "有仓库和安装命令", source_facts: {} });
  });

  it("still enforces score's 1-5 range and score_reason's 80-char cap", () => {
    expect(() => scoreResultSchema.parse({ score: 0, score_reason: "x", source_facts: {} })).toThrow();
    expect(() => scoreResultSchema.parse({ score: 3, score_reason: "x".repeat(81), source_facts: {} })).toThrow();
  });
});

describe("finalizeSourceFacts", () => {
  const now = new Date("2026-09-20T12:00:00Z");

  it("sets as_of to today when a fact was filled", () => {
    expect(finalizeSourceFacts({ repo_url: "https://github.com/a/b" }, now).as_of).toBe("2026-09-20");
    expect(finalizeSourceFacts({ stars: 10 }, now).as_of).toBe("2026-09-20");
    expect(finalizeSourceFacts({ license: "MIT" }, now).as_of).toBe("2026-09-20");
  });

  it("leaves as_of null when no fact was filled", () => {
    expect(finalizeSourceFacts({}, now).as_of).toBeNull();
    expect(finalizeSourceFacts({ repo_url: null, stars: null }, now).as_of).toBeNull();
  });

  it("ignores any as_of the model already set, always recomputing it", () => {
    expect(finalizeSourceFacts({ as_of: "2020-01-01" }, now).as_of).toBeNull();
    expect(finalizeSourceFacts({ repo_url: "https://x", as_of: "2020-01-01" }, now).as_of).toBe("2026-09-20");
  });

  it("preserves the other fields unchanged", () => {
    const result = finalizeSourceFacts({ repo_url: "https://x", stars: 5, license: "MIT" }, now);
    expect(result).toEqual({ repo_url: "https://x", stars: 5, license: "MIT", as_of: "2026-09-20" });
  });
});
