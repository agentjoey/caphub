import { describe, expect, it } from "vitest";
import { INTERFACE_TAGS, RESERVED_TAGS } from "./card";
import { CAPABILITY_TYPE_DEFINITIONS, backfillScorePrompt, deepSynthesizePrompt, enrichPrompt, reasonPrompt, visionPrompt, type EnrichSubject } from "./prompts";

const material = { kind: "text" as const, text: "hello" };
const scenarios = [
  { slug: "coding", labelZh: "编程", labelEn: "Coding", keywords: ["开发", "代码"] },
  { slug: "writing", labelZh: "写作", labelEn: "Writing", keywords: ["文案"] }
];

describe("CAPABILITY_TYPE_DEFINITIONS", () => {
  it("gives all seven capability types a crisp definition, not a bare label", () => {
    expect(CAPABILITY_TYPE_DEFINITIONS).toMatch(/skill（[^）]+）/);
    expect(CAPABILITY_TYPE_DEFINITIONS).toMatch(/experience（[^）]+）/);
    expect(CAPABILITY_TYPE_DEFINITIONS).toMatch(/plugin（[^）]+）/);
    expect(CAPABILITY_TYPE_DEFINITIONS).toMatch(/prompt（[^）]+）/);
    expect(CAPABILITY_TYPE_DEFINITIONS).toMatch(/tool（[^）]+）/);
    expect(CAPABILITY_TYPE_DEFINITIONS).toMatch(/model（[^）]+）/);
    expect(CAPABILITY_TYPE_DEFINITIONS).toMatch(/other（[^）]+）/);
  });

  it("tells the model other is only for what none of the six fit, not a default fallback", () => {
    expect(CAPABILITY_TYPE_DEFINITIONS).toMatch(/other（以上六类都不合适时才用/);
    expect(CAPABILITY_TYPE_DEFINITIONS).toMatch(/不是默认兜底/);
  });

  it("draws the tool/skill, tool/plugin and tool/model boundaries explicitly", () => {
    expect(CAPABILITY_TYPE_DEFINITIONS).toMatch(/skill 是被你或 agent 调用的可复用技能\/工作流\/脚本/);
    expect(CAPABILITY_TYPE_DEFINITIONS).toMatch(/tool 是自己就能跑起来的成品应用或框架/);
    expect(CAPABILITY_TYPE_DEFINITIONS).toMatch(/plugin 必须插进某个宿主平台/);
    expect(CAPABILITY_TYPE_DEFINITIONS).toMatch(/tool 是能直接跑起来的成品应用\/框架；model 是模型资产/);
  });

  it("gives the collection tie-breaker rule: a 合集/库 is typed by what it contains", () => {
    expect(CAPABILITY_TYPE_DEFINITIONS).toMatch(/合集\/库按它收录的内容定型/);
    expect(CAPABILITY_TYPE_DEFINITIONS).toContain("提示词合集/库记为 prompt");
    expect(CAPABILITY_TYPE_DEFINITIONS).toContain("skill 合集/库记为 skill");
  });
});

describe("reasonPrompt", () => {
  it("includes the shared capability-type definitions", () => {
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar: [], existingTags: [], scenarios });
    expect(prompt).toContain(CAPABILITY_TYPE_DEFINITIONS);
  });

  it("says nothing about a pinned type when none is given", () => {
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar: [], existingTags: [], scenarios, pinnedType: null });
    expect(prompt).not.toMatch(/硬性约束/);
  });

  it("adds a hard constraint to use the pinned type and shape the playbook for it, when one is given", () => {
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar: [], existingTags: [], scenarios, pinnedType: "experience" });
    expect(prompt).toMatch(/硬性约束/);
    expect(prompt).toContain("experience");
    expect(prompt).toMatch(/不得改判为其他类型/);
    expect(prompt).toMatch(/playbook\.content/);
  });

  it("instructs tags to be lowercase English words or hyphenated phrases, never Chinese or reserved words", () => {
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar: [], existingTags: [], scenarios });
    expect(prompt).toContain("web-scraping");
    expect(prompt).toContain("不能是中文");
    for (const word of RESERVED_TAGS) expect(prompt).toContain(word);
  });

  it("requires one of the four fixed interface tags when the interface is clear, and bans synonyms", () => {
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar: [], existingTags: [], scenarios });
    for (const tag of INTERFACE_TAGS) expect(prompt).toContain(tag);
    expect(prompt).toContain("mcp-server");
    expect(prompt).toContain("python-library");
    expect(prompt).toContain("cli-tool");
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

  it("lists similar-card candidates as 编号 · 标题 · 类型 · 一句话, for overlap judging", () => {
    const similar = [{ id: "cab_1", code: "TOL-0009", title: "已有工具", type: "tool" as const, summary: "一句话摘要", tags: ["cli"] }];
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar, existingTags: [], scenarios });
    expect(prompt).toContain("TOL-0009 · 已有工具 · tool · 一句话摘要");
  });

  it("asks for the overlap relation to the most related candidate, with a ≤80-char reason, and forbids citing codes outside the list", () => {
    const similar = [{ id: "cab_1", code: "TOL-0009", title: "已有工具", type: "tool" as const, summary: "一句话摘要", tags: [] }];
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar, existingTags: [], scenarios });
    expect(prompt).toMatch(/overlap/);
    expect(prompt).toMatch(/none|duplicate|upgrade|superseded|complement/);
    expect(prompt).toMatch(/不超过 80 字/);
    expect(prompt).toMatch(/严禁引用候选列表以外的编号/);
  });

  it("tells the model overlap must be none/null when there are no similar candidates", () => {
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar: [], existingTags: [], scenarios });
    expect(prompt).toMatch(/overlap\.relation 必须填 none/);
    expect(prompt).toMatch(/overlap\.target 必须为 null/);
  });

  it("tells summary it's the lead only, not the analysis process", () => {
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar: [], existingTags: [], scenarios });
    expect(prompt).toMatch(/summary 是引子/);
    expect(prompt).toMatch(/不展开细节，细节交给 summary_points/);
    expect(prompt).toContain("经联网核实");
    expect(prompt).toContain("未直接证实");
    expect(prompt).toContain("待实测");
  });

  it("tells summary_points to give 3–5 short label+sentence points, one fact each, never a whole paragraph in one point", () => {
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar: [], existingTags: [], scenarios });
    expect(prompt).toMatch(/summary_points 给 3–5 条/);
    expect(prompt).toMatch(/label 是不超过 8 字的短标签/);
    expect(prompt).toMatch(/text 是不超过 60 字的一句说明句/);
    expect(prompt).toMatch(/绝不能把一整段话塞进一条 point/);
  });

  it("confines provenance/confidence to exactly one signals entry, never the summary", () => {
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar: [], existingTags: [], scenarios });
    expect(prompt).toMatch(/signals 给 2–3 条价值信号，其中恰好一条专门讲来源可信度/);
    expect(prompt).toMatch(/不得写进 summary/);
  });

  it("asks for 0-3 open_questions, each ≤30 chars, about the capability rather than the analysis", () => {
    const prompt = reasonPrompt({ material, extraction: null, sources: [], similar: [], existingTags: [], scenarios });
    expect(prompt).toMatch(/open_questions 列出 0–3 条/);
    expect(prompt).toMatch(/每条不超过 30 字/);
    expect(prompt).toMatch(/不能是关于这次分析过程本身的问题/);
    expect(prompt).toMatch(/下一轮补充调研的检索目标/);
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
  playbook: { kind: "integrate", install: ["npm i -D @axe-core/playwright"], repo: "https://github.com/a/b" },
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

describe("deepSynthesizePrompt", () => {
  const subject = {
    title: "Scrapling", type: "tool" as const, summary: "抓取框架",
    tags: ["web-scraping"], source_url: "https://example.com", playbook: { kind: "reference" as const, points: ["p"] }
  };
  const sources = [{ title: "Docs", url: "https://a.example/1" }, { title: "Reddit", url: "https://b.example/2" }];

  it("numbers the retrieved sources from 0 so both cases and feedback can index into them", () => {
    const prompt = deepSynthesizePrompt(subject, sources, ["fact one"]);
    expect(prompt).toContain("[0] Docs https://a.example/1");
    expect(prompt).toContain("[1] Reddit https://b.example/2");
  });

  it("asks feedback points for a source index, with null as the honest escape hatch rather than a guessed index", () => {
    const prompt = deepSynthesizePrompt(subject, sources, ["fact one"]);
    // The point itself is capped and shaped as { text, source } …
    expect(prompt).toMatch(/feedback[^\n]*text ≤ 40 字, source/);
    // … and the grounding rule spells out both branches, including the no-guessing instruction.
    expect(prompt).toMatch(/说不出具体出处时，必须填 null/);
    expect(prompt).toMatch(/绝不能为了把 source 填上就随便挑一个下标/);
  });

  it("still forbids invented cases when nothing was retrieved", () => {
    const prompt = deepSynthesizePrompt(subject, [], []);
    expect(prompt).toContain("原始检索结果：无。");
    expect(prompt).toMatch(/cases 必须是空数组/);
  });

  it("renders a （无） placeholder for 摘要要点 when the subject has no summary_points", () => {
    const prompt = deepSynthesizePrompt(subject, [], []);
    expect(prompt).toContain("摘要要点：（无）");
  });

  it("folds the subject's summary_points into the deep-analysis subject text, not just the ~120-char summary lead (M3.8: most of a card's substance now lives in summary_points)", () => {
    const withPoints = { ...subject, summary_points: [{ label: "定位", text: "自适应反爬抓取库" }, { label: "限制", text: "仅支持 Python" }] };
    const prompt = deepSynthesizePrompt(withPoints, [], []);
    expect(prompt).toContain("摘要要点：**定位。** 自适应反爬抓取库 **限制。** 仅支持 Python");
  });
});

describe("enrichPrompt", () => {
  const subject: EnrichSubject = {
    title: "Scrapling", type: "tool", usage: "integrate", summary: "一个抓取库",
    summary_points: [{ label: "定位", text: "自适应反爬抓取库" }],
    signals: ["s1"], playbook: { kind: "integrate", install: ["pip install scrapling"], repo: null },
    tags: ["web-scraping"], source_url: "https://github.com/a/b", open_questions: [], pinned: false
  };

  it("includes the subject's existing summary_points, rendered as **label。** text", () => {
    const prompt = enrichPrompt(subject, null, []);
    expect(prompt).toContain("**定位。** 自适应反爬抓取库");
  });

  it("renders a （无） placeholder for 摘要要点 when the subject has no summary_points yet", () => {
    const prompt = enrichPrompt({ ...subject, summary_points: [] }, null, []);
    expect(prompt).toContain("摘要要点：（无）");
  });

  it("tells summary it's the lead only (≤120 chars), not a process narration", () => {
    const prompt = enrichPrompt(subject, null, []);
    expect(prompt).toMatch(/summary 是引子：一句话（≤ 120 字）说明这个能力是什么，不展开细节，细节交给 summary_points/);
    expect(prompt).toMatch(/禁止出现「经核实」「未直接证实」「抓取失败」这类过程叙述占据正文/);
  });

  it("tells summary_points to give 3–5 short label+sentence points, one fact each, forbidding a whole paragraph in one point", () => {
    const prompt = enrichPrompt(subject, null, []);
    expect(prompt).toMatch(/summary_points 给 3–5 条 `\{ label, text \}`/);
    expect(prompt).toMatch(/label 是不超过 8 字的短标签/);
    expect(prompt).toMatch(/text 是不超过 60 字的一句说明句/);
    expect(prompt).toMatch(/绝不能把一整段话塞进一条 point，也不能让多条 point 重复同一件事/);
  });
});

it("asks vision for verbatim prompts and reason for locators on text, never for prompt 全文", () => {
  expect(visionPrompt("")).toContain("逐字抄录");
  const common = { extraction: null, sources: [], similar: [], existingTags: [], scenarios: [{ slug: "coding", labelZh: "编程", labelEn: "Coding", keywords: [] }] };
  const text = reasonPrompt({ ...common, material: { kind: "text", text: "hi" } } as never);
  expect(text).toContain("prompt_locators 标出");
  expect(text).not.toContain("prompt 全文");
  const image = reasonPrompt({ ...common, material: { kind: "image", png: new Uint8Array(), ocrText: "", width: 1, height: 1 } } as never);
  expect(image).toContain("prompt_locators 给空数组");
});
