import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cardSchemaFor, loadScenarios, scenariosPromptList, scenariosResultSchemaFor, type Scenario } from "./scenarios";

const valid = {
  title: "用 Playwright 生成 axe 可访问性报告", type: "skill", summary: "一段摘要",
  summary_points: [{ label: "定位", text: "CI 里生成 axe 可访问性报告" }, { label: "适用", text: "已有 e2e 套件的项目" }, { label: "限制", text: "不能替代人工走查" }],
  signals: ["解决 CI 里可访问性回归", "与库里已有 e2e-a11y 重叠"],
  suggested_verdict: "keep", suggested_reason: "有可执行命令", confidence: 0.9,
  usage: "integrate", playbook: { kind: "integrate", install: ["npm i -D @axe-core/playwright"], repo: null, prompt_text: null },
  tags: ["testing", "accessibility"], source_url: null,
  score: 4, score_reason: "有仓库和安装命令，可复现性高"
};

describe("loadScenarios", () => {
  it("selects the seeded columns ordered by sort", async () => {
    let sql = "";
    const pool: Pick<Pool, "query"> = {
      query: (async (text: string) => {
        sql = text;
        return { rows: [{ slug: "coding", label_zh: "编程", label_en: "Coding", keywords: ["code", "debugging"] }] };
      }) as never
    };
    const out = await loadScenarios(pool);
    expect(sql).toContain("FROM caphub_v2.scenarios");
    expect(sql).toContain("ORDER BY sort");
    expect(out).toEqual<Scenario[]>([{ slug: "coding", labelZh: "编程", labelEn: "Coding", keywords: ["code", "debugging"] }]);
  });
});

describe("scenariosPromptList", () => {
  it("renders slug（中文名：关键词…） joined by 、and ；", () => {
    const list: Scenario[] = [
      { slug: "coding", labelZh: "编程", labelEn: "Coding", keywords: ["开发", "代码"] },
      { slug: "writing", labelZh: "写作", labelEn: "Writing", keywords: ["文案"] }
    ];
    expect(scenariosPromptList(list)).toBe("coding（编程：开发、代码）；writing（写作：文案）");
  });
});

describe("cardSchemaFor", () => {
  const slugs = ["coding", "writing", "design"];

  it("requires 1-3 scenarios from the given slug list", () => {
    const schema = cardSchemaFor(slugs);
    expect(schema.parse({ ...valid, scenarios: ["coding"] }).scenarios).toEqual(["coding"]);
    expect(schema.parse({ ...valid, scenarios: ["coding", "writing", "design"] }).scenarios).toEqual(["coding", "writing", "design"]);
    expect(() => schema.parse({ ...valid, scenarios: [] })).toThrow();
    expect(() => schema.parse({ ...valid, scenarios: ["coding", "writing", "design", "coding"].slice(0, 4) })).not.toThrow();
  });

  it("rejects a scenario slug outside the given list", () => {
    const schema = cardSchemaFor(slugs);
    expect(() => schema.parse({ ...valid, scenarios: ["not-a-real-slug"] })).toThrow();
  });

  it("dedupes repeated scenario slugs before enforcing max 3", () => {
    const schema = cardSchemaFor(slugs);
    expect(schema.parse({ ...valid, scenarios: ["coding", "coding", "writing"] }).scenarios).toEqual(["coding", "writing"]);
  });

  it("still enforces the underlying card rules (e.g. usage/playbook match)", () => {
    const schema = cardSchemaFor(slugs);
    expect(() => schema.parse({ ...valid, scenarios: ["coding"], usage: "integrate", playbook: { kind: "reference", points: ["a"] } })).toThrow(/integrate/);
  });

  it("stays representable as JSON Schema for providers", () => {
    const schema = cardSchemaFor(slugs);
    const jsonSchema = z.toJSONSchema(schema) as { properties?: Record<string, unknown> };
    expect(jsonSchema.properties?.scenarios).toMatchObject({ type: "array", minItems: 1, maxItems: 3 });
  });

  it("throws when given an empty slug list", () => {
    expect(() => cardSchemaFor([])).toThrow();
  });

  it("with a pinnedType, rejects a card whose type differs, even before checking playbook shape", () => {
    const schema = cardSchemaFor(slugs, "experience");
    expect(() => schema.parse({ ...valid, type: "skill", scenarios: ["coding"] })).toThrow();
  });

  it("with a pinnedType, rejects a card whose playbook doesn't match the pinned type's shape (mismatch caught, not silently stored)", () => {
    const schema = cardSchemaFor(slugs, "experience");
    // type: "experience" is what the model would have to claim to pass the z.literal, but an
    // integrate-shaped playbook still violates refineCard's type/playbook coherence check.
    expect(() => schema.parse({
      ...valid, type: "experience", scenarios: ["coding"],
      usage: "integrate", playbook: { kind: "integrate", install: [], repo: null, prompt_text: null }
    })).toThrow();
  });

  it("with a pinnedType, accepts and stores a card whose type and experience-shaped playbook both match", () => {
    const schema = cardSchemaFor(slugs, "experience");
    const parsed = schema.parse({
      ...valid, type: "experience", scenarios: ["coding"],
      playbook: { kind: "experience", content: "做法本身", when_to_use: "何时用" }
    });
    expect(parsed.type).toBe("experience");
    expect(parsed.playbook).toEqual({ kind: "experience", content: "做法本身", when_to_use: "何时用" });
  });

  it("without a pinnedType, behaves exactly as before (any valid type/playbook combination passes)", () => {
    const schema = cardSchemaFor(slugs);
    expect(schema.parse({ ...valid, type: "skill", scenarios: ["coding"] }).type).toBe("skill");
  });

  it("still requires score/score_reason and defaults source_facts to {}", () => {
    const schema = cardSchemaFor(slugs);
    const { score: _score, ...withoutScore } = valid as typeof valid & { score: number };
    expect(() => schema.parse({ ...withoutScore, scenarios: ["coding"] })).toThrow();
    expect(schema.parse({ ...valid, scenarios: ["coding"] }).source_facts).toEqual({});
  });

  describe("overlap", () => {
    it("defaults overlap to none/null when omitted, with no candidates offered", () => {
      const schema = cardSchemaFor(slugs);
      expect(schema.parse({ ...valid, scenarios: ["coding"] }).overlap).toEqual({ relation: "none", target: null, reason: "" });
    });

    it("accepts a target that is one of the given candidate codes", () => {
      const schema = cardSchemaFor(slugs, undefined, ["TOL-0009", "SKL-0012"]);
      const overlap = { relation: "duplicate", target: "TOL-0009", reason: "与已有工具重复" };
      expect(schema.parse({ ...valid, scenarios: ["coding"], overlap }).overlap).toEqual(overlap);
    });

    it("rejects a target outside the given candidate list (goes through the invalid-output retry path)", () => {
      const schema = cardSchemaFor(slugs, undefined, ["TOL-0009"]);
      expect(() => schema.parse({
        ...valid, scenarios: ["coding"],
        overlap: { relation: "duplicate", target: "SKL-0012", reason: "r" }
      })).toThrow();
    });

    it("rejects any non-null target when there are no candidates at all", () => {
      const schema = cardSchemaFor(slugs);
      expect(() => schema.parse({
        ...valid, scenarios: ["coding"],
        overlap: { relation: "duplicate", target: "TOL-0009", reason: "r" }
      })).toThrow();
    });

    it("still enforces relation=none <=> target=null via refineCard, even with candidates offered", () => {
      const schema = cardSchemaFor(slugs, undefined, ["TOL-0009"]);
      expect(() => schema.parse({
        ...valid, scenarios: ["coding"],
        overlap: { relation: "none", target: "TOL-0009", reason: "r" }
      })).toThrow(/target/);
      expect(() => schema.parse({
        ...valid, scenarios: ["coding"],
        overlap: { relation: "duplicate", target: null, reason: "r" }
      })).toThrow(/target/);
    });

    it("stays representable as JSON Schema for providers, with target as a plain enum", () => {
      const schema = cardSchemaFor(slugs, undefined, ["TOL-0009", "SKL-0012"]);
      const jsonSchema = z.toJSONSchema(schema) as { properties?: { overlap?: { properties?: Record<string, unknown> } } };
      expect(jsonSchema.properties?.overlap?.properties?.target).toBeDefined();
    });
  });
});

describe("scenariosResultSchemaFor", () => {
  it("validates a bare { scenarios } object against the given slug list", () => {
    const schema = scenariosResultSchemaFor(["coding", "writing"] as const);
    expect(schema.parse({ scenarios: ["coding", "coding"] })).toEqual({ scenarios: ["coding"] });
    expect(() => schema.parse({ scenarios: [] })).toThrow();
    expect(() => schema.parse({ scenarios: ["nope"] })).toThrow();
  });
});
