import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cardObjectSchema, cardSchema, deepAnalysisSchema, deepFactsSchema, deepPlanSchema, extractionSchema, finalizeSourceFacts, isValidTag, MAX_PROMPT_ITEMS_ACCEPTED, playbookSchema, scoreResultSchema, videoExtractionSchema } from "./card";

const valid = {
  title: "用 Playwright 生成 axe 可访问性报告", type: "skill", summary: "一段摘要",
  summary_points: [
    { label: "定位", text: "CI 里自动生成 axe 可访问性报告的 Playwright 用法" },
    { label: "适用", text: "已有 e2e 套件、想顺带跑无障碍检查的项目" },
    { label: "限制", text: "只能查出规则能覆盖的问题，不能替代人工走查" }
  ],
  signals: ["解决 CI 里可访问性回归", "与库里已有 e2e-a11y 重叠"],
  suggested_verdict: "keep", suggested_reason: "有可执行命令", confidence: 0.9,
  usage: "integrate", playbook: { kind: "integrate", install: ["npm i -D @axe-core/playwright"], repo: null, usage_prompt: null },
  tags: ["testing", "accessibility"], source_url: null, scenarios: [],
  score: 4, score_reason: "有仓库和安装命令，可复现性高", source_facts: {},
  overlap: { relation: "none", target: null, reason: "" }, open_questions: [], prompt_locators: []
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
      playbook: { kind: "integrate", install: ["npm i"], repo: "owner/repo" }
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
    it("accepts a score_reason at the 120-char cap and rejects one over it (prompt target is 80)", () => {
      expect(cardSchema.parse({ ...valid, score_reason: "a".repeat(120) }).score_reason).toHaveLength(120);
      expect(() => cardSchema.parse({ ...valid, score_reason: "a".repeat(121) })).toThrow();
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
      expect(jsonSchema.properties?.score_reason).toMatchObject({ type: "string", maxLength: 120 });
      expect(jsonSchema.properties?.source_facts).toMatchObject({ type: "object" });
    });
  });
});

describe("cardSchema open_questions", () => {
  it("defaults to [] when omitted", () => {
    const { open_questions: _oq, ...withoutOpenQuestions } = valid as typeof valid & { open_questions: string[] };
    expect(cardSchema.parse(withoutOpenQuestions).open_questions).toEqual([]);
  });
  it("accepts up to 3 items, each within the cap", () => {
    const open_questions = ["是否需要登录才能用", "免费额度上限是多少", "导出格式有哪些"];
    expect(cardSchema.parse({ ...valid, open_questions }).open_questions).toEqual(open_questions);
    expect(cardSchema.parse({ ...valid, open_questions: ["a".repeat(30)] }).open_questions).toEqual(["a".repeat(30)]);
  });
  it("rejects a 4th item", () => {
    expect(() => cardSchema.parse({ ...valid, open_questions: ["a", "b", "c", "d"] })).toThrow();
  });
  it("accepts an item at the 45-char cap and rejects one over it (prompt target is 30)", () => {
    expect(cardSchema.parse({ ...valid, open_questions: ["a".repeat(45)] }).open_questions[0]).toHaveLength(45);
    expect(() => cardSchema.parse({ ...valid, open_questions: ["a".repeat(46)] })).toThrow();
  });
  it("stays representable as JSON Schema for providers", () => {
    const jsonSchema = z.toJSONSchema(cardSchema) as { properties?: Record<string, unknown> };
    expect(jsonSchema.properties?.open_questions).toMatchObject({ type: "array", maxItems: 3 });
  });
});

describe("cardSchema summary", () => {
  it("accepts a summary up to 180 chars (the schema cap, looser than the prompt's 120-char shaping target)", () => {
    expect(cardSchema.parse({ ...valid, summary: "a".repeat(180) }).summary).toBe("a".repeat(180));
  });
  it("rejects a summary over 180 chars", () => {
    expect(() => cardSchema.parse({ ...valid, summary: "a".repeat(181) })).toThrow();
  });
  it("accepts a summary that mildly overshoots the prompt's 120-char target (e.g. 150 chars), rather than failing the run", () => {
    expect(cardSchema.parse({ ...valid, summary: "a".repeat(150) }).summary).toBe("a".repeat(150));
  });
});

describe("cardSchema summary_points", () => {
  it("accepts 3 points (the minimum)", () => {
    const summary_points = [{ label: "定位", text: "a" }, { label: "适用", text: "b" }, { label: "限制", text: "c" }];
    expect(cardSchema.parse({ ...valid, summary_points }).summary_points).toEqual(summary_points);
  });
  it("accepts 5 points (the maximum)", () => {
    const summary_points = Array.from({ length: 5 }, (_, i) => ({ label: `点${i}`, text: `说明 ${i}` }));
    expect(cardSchema.parse({ ...valid, summary_points }).summary_points).toEqual(summary_points);
  });
  it("rejects 2 points (below the minimum)", () => {
    const summary_points = [{ label: "定位", text: "a" }, { label: "适用", text: "b" }];
    expect(() => cardSchema.parse({ ...valid, summary_points })).toThrow();
  });
  it("rejects 6 points (above the maximum)", () => {
    const summary_points = Array.from({ length: 6 }, (_, i) => ({ label: `点${i}`, text: `说明 ${i}` }));
    expect(() => cardSchema.parse({ ...valid, summary_points })).toThrow();
  });
  it("rejects a label over 12 chars (the schema cap, looser than the prompt's 8-char shaping target)", () => {
    const summary_points = [
      { label: "一二三四五六七八九十一二三", text: "a" },
      ...valid.summary_points.slice(1)
    ];
    expect(() => cardSchema.parse({ ...valid, summary_points })).toThrow();
  });
  it("accepts a label of exactly 12 chars", () => {
    const summary_points = [
      { label: "一二三四五六七八九十一二", text: "a" },
      ...valid.summary_points.slice(1)
    ];
    expect(cardSchema.parse({ ...valid, summary_points }).summary_points[0].label).toBe("一二三四五六七八九十一二");
  });
  it("accepts a label that mildly overshoots the prompt's 8-char target (e.g. 10 chars), rather than failing the run", () => {
    const summary_points = [{ label: "一二三四五六七八九十", text: "a" }, ...valid.summary_points.slice(1)];
    expect(cardSchema.parse({ ...valid, summary_points }).summary_points[0].label).toBe("一二三四五六七八九十");
  });
  it("rejects a text over 90 chars (the schema cap, looser than the prompt's 60-char shaping target)", () => {
    const summary_points = [{ label: "定位", text: "a".repeat(91) }, ...valid.summary_points.slice(1)];
    expect(() => cardSchema.parse({ ...valid, summary_points })).toThrow();
  });
  it("accepts a text of exactly 90 chars", () => {
    const summary_points = [{ label: "定位", text: "a".repeat(90) }, ...valid.summary_points.slice(1)];
    expect(cardSchema.parse({ ...valid, summary_points }).summary_points[0].text).toBe("a".repeat(90));
  });
  it("accepts a point text that mildly overshoots the prompt's 60-char target (e.g. 75 chars), rather than failing the run", () => {
    const summary_points = [{ label: "定位", text: "a".repeat(75) }, ...valid.summary_points.slice(1)];
    expect(cardSchema.parse({ ...valid, summary_points }).summary_points[0].text).toBe("a".repeat(75));
  });
  it("requires summary_points (missing field fails)", () => {
    const { summary_points: _sp, ...withoutPoints } = valid as typeof valid & { summary_points: unknown };
    expect(() => cardSchema.parse(withoutPoints)).toThrow();
  });
  it("stays representable as JSON Schema for providers", () => {
    const jsonSchema = z.toJSONSchema(cardSchema) as { properties?: Record<string, unknown> };
    expect(jsonSchema.properties?.summary_points).toMatchObject({ type: "array", minItems: 3, maxItems: 5 });
    expect(jsonSchema.properties?.summary).toMatchObject({ type: "string", maxLength: 180 });
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
  it("accepts an overlap reason at the 120-char cap and rejects one over it (prompt target is 80)", () => {
    expect(cardSchema.parse({ ...valid, overlap: { relation: "duplicate", target: "TOL-0009", reason: "a".repeat(120) } }).overlap.reason).toHaveLength(120);
    expect(() => cardSchema.parse({ ...valid, overlap: { relation: "duplicate", target: "TOL-0009", reason: "a".repeat(121) } })).toThrow();
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

  it("still enforces score's 1-5 range and score_reason's 120-char cap", () => {
    expect(() => scoreResultSchema.parse({ score: 0, score_reason: "x", source_facts: {} })).toThrow();
    expect(() => scoreResultSchema.parse({ score: 3, score_reason: "x".repeat(121), source_facts: {} })).toThrow();
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

describe("deep analysis schemas render as JSON Schema", () => {
  // runStructured hands each of these to z.toJSONSchema before calling the provider, so a
  // bare (unpiped) .transform anywhere in them kills the run before the model ever answers.
  it.each([
    ["deep_plan", deepPlanSchema],
    ["deep_facts", deepFactsSchema],
    ["deep_analysis", deepAnalysisSchema]
  ])("%s", (_name, schema) => {
    const json = z.toJSONSchema(schema) as { type?: string; properties?: Record<string, unknown> };
    expect(json.type).toBe("object");
    expect(Object.keys(json.properties ?? {}).length).toBeGreaterThan(0);
  });

  it("still describes cases[].source as a nullable integer", () => {
    const json = z.toJSONSchema(deepAnalysisSchema) as {
      properties?: { cases?: { items?: { properties?: { source?: unknown } } } };
    };
    expect(json.properties?.cases?.items?.properties?.source).toBeDefined();
  });
});

describe("deepAnalysisSchema grounding", () => {
  const base = {
    headline: "h",
    architecture: { summary: "s1", points: ["p1", "p2", "p3"] },
    implementation: { summary: "s2", points: ["p1", "p2", "p3"] },
    use_cases: [{ title: "u1", detail: "d1" }, { title: "u2", detail: "d2" }, { title: "u3", detail: "d3" }],
    cases: [],
    feedback: { positive: [], negative: [] },
    risks: ["r1", "r2"],
    sources: [{ title: "Docs", url: "https://a.example/1" }]
  };

  it("accepts an architecture point that lists sub-skill identifiers (SKL-0031's real output)", () => {
    // The 73-char ASCII line that failed SKL-0031's third deep-analysis run against the 60-char cap.
    const listing = "拆为 core/timeline/scrolltrigger/plugins/utils/react/performance/frameworks";
    expect(listing.length).toBeGreaterThan(60);
    const parsed = deepAnalysisSchema.parse({
      ...base,
      architecture: { summary: "s1", points: [listing, "p2", "p3"] }
    });
    expect(parsed.architecture.points[0]).toBe(listing);
  });

    it("accepts a feedback point citing a real source, and one citing none at all", () => {
    const parsed = deepAnalysisSchema.parse({
      ...base,
      feedback: { positive: [{ text: "上手快", source: 0 }], negative: [{ text: "文档薄", source: null }] }
    });
    expect(parsed.feedback.positive[0]).toEqual({ text: "上手快", source: 0 });
    expect(parsed.feedback.negative[0].source).toBeNull();
  });

  it("coerces a feedback point's out-of-range source index to null instead of failing", () => {
    const result = deepAnalysisSchema.parse({
      ...base,
      feedback: { positive: [], negative: [{ text: "文档薄", source: 3 }] }
    });
    expect(result.feedback.negative[0]).toEqual({ text: "文档薄", source: null });
  });

  it("coerces an out-of-range case citation to null, and still rejects a bare-string feedback point", () => {
    const result = deepAnalysisSchema.parse({ ...base, cases: [{ title: "c", detail: "d", source: 9 }] });
    expect(result.cases[0].source).toBeNull();
    expect(deepAnalysisSchema.safeParse({ ...base, feedback: { positive: ["上手快"], negative: [] } }).success).toBe(false);
  });

  it("rejects a negative or non-integer source index rather than coercing it", () => {
    expect(deepAnalysisSchema.safeParse({ ...base, cases: [{ title: "c", detail: "d", source: -1 }] }).success).toBe(false);
    expect(deepAnalysisSchema.safeParse({ ...base, cases: [{ title: "c", detail: "d", source: 1.5 }] }).success).toBe(false);
    expect(deepAnalysisSchema.safeParse({
      ...base,
      feedback: { positive: [{ text: "上手快", source: -1 }], negative: [] }
    }).success).toBe(false);
  });

  it("accepts a card whose every field sits well over the prompt's shaping targets but within the schema's caps", () => {
    const over = (n: number) => "字".repeat(n);
    const result = deepAnalysisSchema.safeParse({
      headline: over(52), // prompt target 40, ~1.3x
      architecture: { summary: over(104), points: [over(52), over(52), over(52)] }, // targets 80 / 40
      implementation: { summary: over(104), points: [over(52), over(52), over(52)] },
      use_cases: [
        { title: over(26), detail: over(78) }, // targets 20 / 60
        { title: over(26), detail: over(78) },
        { title: over(26), detail: over(78) }
      ],
      cases: [{ title: over(39), detail: over(78), source: 0 }], // targets 30 / 60
      feedback: {
        positive: [{ text: over(52), source: 0 }], // target 40
        negative: []
      },
      risks: [over(65), over(65)], // target 50
      sources: [{ title: "Docs", url: "https://a.example/1" }]
    });
    expect(result.success).toBe(true);
  });
});

describe("verbatim prompt fields", () => {
  it("extraction carries a list of transcribed prompts, schema-capped at MAX_PROMPT_ITEMS_ACCEPTED (looser than the MAX_PROMPTS storage cap, so a 21+-item card can still validate and go to Review instead of dying at schema validation)", () => {
    const base = { what: "w", visible_text: "", commands: [], source_hints: [], questions: [] };
    expect(extractionSchema.parse({ ...base, prompts: ["a", "b"] }).prompts).toEqual(["a", "b"]);
    // 21..50 must validate (this used to reject at 21, the old MAX_PROMPTS cap).
    for (const n of [21, 35, MAX_PROMPT_ITEMS_ACCEPTED]) {
      expect(extractionSchema.parse({ ...base, prompts: Array(n).fill("x") }).prompts).toHaveLength(n);
    }
    expect(() => extractionSchema.parse({ ...base, prompts: Array(MAX_PROMPT_ITEMS_ACCEPTED + 1).fill("x") })).toThrow();
  });

  it("integrate playbooks no longer carry prompt text, but default usage_prompt to null", () => {
    const parsed = playbookSchema.parse({ kind: "integrate", install: [], repo: null, prompt_text: "legacy" });
    expect(parsed).toEqual({ kind: "integrate", install: [], repo: null, usage_prompt: null });
  });

  it("integrate playbooks accept a model-written usage_prompt, distinct from prompt_text", () => {
    const parsed = playbookSchema.parse({ kind: "integrate", install: [], repo: null, usage_prompt: "用 xyz skill 帮我做 abc" });
    expect(parsed).toEqual({ kind: "integrate", install: [], repo: null, usage_prompt: "用 xyz skill 帮我做 abc" });
  });

  it("cards default prompt_locators to [] and cap anchors short", () => {
    const shape = cardObjectSchema.shape.prompt_locators;
    expect(shape.parse(undefined)).toEqual([]);
    expect(() => shape.parse([{ start: "x".repeat(81), end: "y" }])).toThrow();
  });

  it("cards accept 21..50 prompt_locators (schema cap), not just up to the 20-item storage cap", () => {
    const shape = cardObjectSchema.shape.prompt_locators;
    const locator = { start: "s", end: "e" };
    for (const n of [21, 35, MAX_PROMPT_ITEMS_ACCEPTED]) {
      expect(shape.parse(Array(n).fill(locator))).toHaveLength(n);
    }
    expect(() => shape.parse(Array(MAX_PROMPT_ITEMS_ACCEPTED + 1).fill(locator))).toThrow();
  });
});

describe("videoExtractionSchema", () => {
  const base = { what: "w", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [] };
  it("accepts content points with a timestamp or null, defaulting to []", () => {
    expect(videoExtractionSchema.parse(base).content_points).toEqual([]);
    expect(videoExtractionSchema.parse({ ...base, content_points: [{ t: "04:08", point: "p" }, { t: null, point: "q" }] }).content_points).toHaveLength(2);
    expect(() => videoExtractionSchema.parse({ ...base, content_points: [{ t: "4m", point: "p" }] })).toThrow();
  });

  it("accepts key moments with mm:ss or h:mm:ss and defaults to []", () => {
    expect(videoExtractionSchema.parse(base).key_moments).toEqual([]);
    // Same field name as content_points: Gemini kept writing "point" here (2026-09-23), so the
    // schema follows it rather than failing whole video runs over a field name.
    expect(() => videoExtractionSchema.parse({ ...base, key_moments: [{ t: "01:57", note: "old name" }] })).toThrow();
    expect(videoExtractionSchema.parse({ ...base, key_moments: [{ t: "01:57", point: "n" }, { t: "1:02:03", point: "m" }] }).key_moments).toHaveLength(2);
    expect(() => videoExtractionSchema.parse({ ...base, key_moments: [{ t: "1m", point: "n" }] })).toThrow();
  });
});
