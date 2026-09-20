import type { CanonicalResult } from "./canonical";
import { INTERFACE_TAGS, RESERVED_TAGS, type Card, type CapabilityType, type DeepSource, type Extraction, type SearchResult } from "./card";
import type { Material } from "./material";
import type { Scenario } from "./scenarios";
import { scenariosPromptList } from "./scenarios";
import type { SimilarCandidate } from "./similar";

/**
 * Shared scoring rubric wording, used both in the pipeline's `reasonPrompt` (score assigned
 * alongside the rest of the card, with web sources in hand) and in the score backfill
 * script's `backfillScorePrompt` (score assigned after the fact, from the card's own text
 * only). Kept as one string so the two call sites can't drift into inconsistent rubrics.
 */
export const SCORE_RUBRIC = "评分标准：成熟度（是否稳定可用）、可复现性（是否有仓库 / 安装路径 / 提示词原文，能不能照着做出来）、对 Joey 的适用度（是否匹配他的实际场景）、与库内已有能力的互补性（是否重复造轮子）。4–5 分表示建议直接整合，1–2 分表示通常该丢弃，3 分是中间地带。";

/**
 * Shared capability-type definitions, used both in the pipeline's `reasonPrompt` (assigns
 * `type` alongside the rest of the card) and in the one-off `scripts/reclassify-types.ts`
 * (re-asks `type` alone for existing cards). Kept as one string, and compact, since it's sent
 * on every analysis call — a prompt library ("GPT Image 2 提示词库与图像生成参考资源") was once
 * misclassified as `other` because `plugin`/`prompt`/`other` carried no definition at all.
 */
export const CAPABILITY_TYPE_DEFINITIONS =
  "能力类型定义：skill（可安装/可执行的技能，如脚本、CLI、agent skill、可复用的工作流）；experience（一次具体实践得到的做法/教训/复盘，需要保留核心内容本身而不只是链接）；plugin（面向某个宿主平台——IDE、浏览器、聊天客户端等——的可安装插件/扩展）；prompt（可直接复用的提示词本身，单条提示词或提示词合集/库都算）；tool（可独立运行的应用/工具/框架：自带运行入口，不依附某个宿主，如 CLI 应用、桌面或 Web 应用、本地服务、agent 运行框架）；model（模型本身：权重、基础模型、微调产物及其推理代码；不是围绕模型的应用）；other（以上六类都不合适时才用，不是默认兜底）。skill 与 tool 的边界：skill 是被你或 agent 调用的可复用技能/工作流/脚本，tool 是自己就能跑起来的成品应用或框架。tool 与 plugin 的边界：plugin 必须插进某个宿主平台，tool 不需要宿主、自己就是入口。tool 与 model 的边界：tool 是能直接跑起来的成品应用/框架；model 是模型资产，通常要被代码或应用调用。合集/库按它收录的内容定型，不要因为「是个合集」就归为 other：提示词合集/库记为 prompt，skill 合集/库记为 skill，以此类推。";

export function visionPrompt(ocrText: string): string {
  return [
    "你在整理一个个人 agent 能力库。请仔细看这张图片，提取其中关于「能力」（skill、经验、plugin、prompt 等）的信息。",
    "要求：what 用一两句话说明图里展示的是什么能力；visible_text 抄录图中可见的关键文字；commands 抄录可见的安装/运行命令；prompt_text 若图中有完整提示词原文则逐字抄录否则为 null；source_hints 列出可见的作者、仓库、网址、产品名；questions 列出看图无法确定、需要联网核实的问题（最多 5 条）。",
    ocrText ? `OCR 参考文本（可能有错）：\n${ocrText}` : ""
  ].filter(Boolean).join("\n\n");
}

export function searchQuery(extraction: Extraction | null, material: Material): string {
  if (extraction) return [extraction.what, ...extraction.source_hints, ...extraction.questions.slice(0, 2)].join(" ").slice(0, 400);
  if (material.kind === "url") return material.url;
  return material.kind === "text" ? material.text.slice(0, 400) : "";
}

export function reasonPrompt(input: {
  material: Material; extraction: Extraction | null; sources: SearchResult["sources"];
  similar: SimilarCandidate[]; existingTags: string[]; scenarios: Scenario[];
  /**
   * When a human has already hand-set this capability's `type` (via 改建议), a rerun must
   * honor it rather than let the model re-derive (and possibly revert) it — see
   * lib/analysis/pipeline.ts. Passed as a hard constraint on `type` and on how `playbook`
   * must be shaped for it (e.g. an `experience` card must put the core content into
   * `playbook.content`); pipeline.ts also forces `card.type` to this value after parsing, as
   * a backstop against a disobedient model.
   */
  pinnedType?: CapabilityType | null;
}): string {
  const materialText = input.material.kind === "text" ? input.material.text
    : input.material.kind === "url" ? `URL: ${input.material.url}\n页面正文：${input.material.text ?? "（抓取失败）"}`
    : `（图片，见视觉提取结果）`;
  return [
    `你在为一个个人 agent 能力库做评估与建档。${CAPABILITY_TYPE_DEFINITIONS}`,
    input.pinnedType
      ? `硬性约束：这张卡片的 type 已由人工确定为「${input.pinnedType}」，本次重跑必须原样使用这个 type，不得改判为其他类型；playbook 必须按这个 type 的形状组织内容（例如 type 为 experience 时，必须把核心内容本身写进 playbook.content）。`
      : "",
    `原始输入：\n${materialText}`,
    input.extraction ? `视觉提取结果：\n${JSON.stringify(input.extraction)}` : "",
    input.sources.length ? `联网来源（已截断）：\n${input.sources.map((s, i) => `[${i + 1}] ${s.title} ${s.url}\n${s.content}`).join("\n\n")}` : "联网来源：无",
    input.similar.length
      ? `库里已有的相似能力（候选相似卡，编号 · 标题 · 类型 · 一句话，用于判断是否重叠）：\n${input.similar.map((s) => `${s.code ?? "（无编号）"} · ${s.title} · ${s.type} · ${s.summary}`).join("\n")}`
      : "库里没有相似能力。",
    `已有标签（优先复用，找到贴切的就不要新造）：${input.existingTags.join(", ") || "（空）"}`,
    `候选应用场景（slug（中文名：关键词…））：${scenariosPromptList(input.scenarios)}`,
    "请输出 CapabilityCard：title ≤ 30 字的一句话；type；summary 是引子——一句话（≤ 120 字）说明这个能力是什么，不展开细节，细节交给 summary_points；summary 只写关于能力的事实性描述，绝不能复述你是怎么分析/核实的，禁止出现「经联网核实」「未直接证实」「待实测」这类过程叙述占据正文；来源是否可信、有没有核实到，只放进 signals 里恰好一条，不得写进 summary；" +
      "summary_points 给 3–5 条 `{ label, text }`：label 是不超过 8 字的短标签（如「定位」「适用场景」「限制」「用法」），text 是不超过 60 字的一句说明句，呈现为 `**label。** text` 的效果；每条只讲一件事——它解决什么问题、怎么用、适合谁、边界/局限在哪等，绝不能把一整段话塞进一条 point，也不能让多条 point 重复同一件事；这部分承接 summary 留白的细节，合起来才是完整的能力说明；" +
      "signals 给 2–3 条价值信号，其中恰好一条专门讲来源可信度/是否已核实，其余讲解决什么场景、与库内谁重叠等；suggested_verdict 与 suggested_reason；confidence 是你对该建议的把握（0–1）；usage 在 integrate（可直接拿来用）与 reference（值得借鉴后自研）之间选；playbook 按 usage/type 给可执行内容：integrate 给 install 命令、repo、prompt 全文；reference 给借鉴要点；experience 类型必须把核心内容本身写进 content；" +
      `tags 给 1–6 个标签，每个必须是英文小写单词或用连字符连接的短语（如 web-scraping、time-series），不能是中文，不能是空格分隔的多词（"Web Scraping" 不合法，要写成 web-scraping），也不能是 ${RESERVED_TAGS.join("、")} 这类类型/用途词；已有贴切的标签要复用，不要为同一含义新造近义词；当能力的接入方式明确时，必须使用这四个固定标签中的一个或多个（${INTERFACE_TAGS.join("、")}），不要自造近义词（例如 mcp-server、python-library、cli-tool、skill 都不允许）；接入方式标签与主题标签共用 1–6 个标签的名额，不额外增加数量；` +
      "scenarios 从候选应用场景的 slug 中选出 1–3 个这个能力最可能被用在的应用场景，按贴切程度排列，只能用给出的 slug，不要自造；" +
      "source_url 给最可信的来源链接或 null。",
    input.similar.length
      ? `overlap 判断本卡与上面「候选相似卡」列表中最相关的一张的关系：relation 在 none（无关）、duplicate（与对方重复）、upgrade（本卡是对方的升级版）、superseded（本卡已被对方取代）、complement（与对方互补）之间选；target 必须原样填写候选列表里给出的编号（如 TOL-0009），relation 为 none 时 target 必须为 null；严禁引用候选列表以外的编号；reason 用一句不超过 80 字的中文说明判断依据。`
      : "候选相似卡列表为空，overlap.relation 必须填 none，overlap.target 必须为 null，reason 说明库里暂无相似能力。",
    `score 给这个能力对 Joey 的 AI 价值打 1–5 分整数，${SCORE_RUBRIC}score_reason 用一句不超过 80 字的中文说明打分依据。`,
    "open_questions 列出 0–3 条你看了当前输入后仍无法确定、需要进一步核实的问题，每条不超过 30 字；每条必须是关于这个能力本身的问题（例如「是否需要登录才能用」「免费额度上限是多少」「导出格式有哪些」），不能是关于这次分析过程本身的问题；这些问题会成为下一轮补充调研的检索目标，没有疑问就留空数组，不要为了填满而硬凑。",
    "source_facts 是关于来源的客观事实（repo_url、stars、last_update、license、homepage），只能填写「联网来源」中明确写出的内容；某一项在来源里没有明确出现就留空（不要填、不要猜），禁止推测 star 数与更新时间（last_update）这类你不确定的数字或日期；如果联网来源为空或完全没提到这些事实，source_facts 整体留空对象即可。as_of 填写你依据的来源信息的日期（若来源本身没有日期，可留空）。"
  ].filter(Boolean).join("\n\n");
}

/**
 * Prompt for the score backfill script (`scripts/backfill-score.ts`): scores an existing
 * card from its own stored fields only, with no web search step behind it. Reuses
 * `SCORE_RUBRIC` verbatim rather than inventing a second rubric, but replaces
 * `reasonPrompt`'s source-facts instruction (which assumes web sources are in hand) with one
 * that says explicitly there is no new search here — only a `repo_url` visible in the card's
 * own `source_url`/`playbook` may be filled; everything else stays empty unless the card text
 * states it. `as_of` is set by the caller (`finalizeSourceFacts`), not the model, so the
 * prompt doesn't ask for it.
 */
export function backfillScorePrompt(input: {
  title: string; summary: string; signals: string[]; playbook: unknown; tags: string[]; source_url: string | null;
}): string {
  return [
    "你在给个人 agent 能力库里已经建档的一张卡片补打分。这里没有新的联网搜索，只能依据下面这张卡片自己已有的文字内容判断，不要假设你知道卡片之外的信息。",
    `标题：${input.title}`,
    `摘要：${input.summary}`,
    `价值信号：${input.signals.join("；") || "（无）"}`,
    `Playbook：${JSON.stringify(input.playbook)}`,
    `标签：${input.tags.join(", ") || "（无）"}`,
    `已有来源链接：${input.source_url ?? "（无）"}`,
    `score 给这个能力对 Joey 的 AI 价值打 1–5 分整数，${SCORE_RUBRIC}score_reason 用一句不超过 80 字的中文说明打分依据。`,
    "source_facts 是关于来源的客观事实（repo_url、stars、last_update、license、homepage）：因为这里没有联网搜索，只能看到卡片本身的文字，所以只应在「已有来源链接」或 Playbook 里能直接看到仓库地址时才填 repo_url；stars、last_update、license、homepage 除非卡片文字里明确写出，否则一律留空，不要填、不要猜，禁止推测 star 数与更新时间这类你不确定的数字或日期。不要填写 as_of，留空即可。"
  ].join("\n\n");
}

// --- Deep analysis (M3.6) ---------------------------------------------------------------
// See lib/analysis/deep.ts. Design decision 5 (owner): the output must stay short and
// scannable, never a wall of text -- every prompt below repeats the field length caps so the
// model doesn't have to infer them from the JSON schema alone.

/** The subset of an existing CapabilityCard a deep-analysis run is triggered against. */
export interface DeepSubject {
  title: string; type: CapabilityType; summary: string; summary_points?: Card["summary_points"]; tags: string[];
  source_url: string | null; playbook: Card["playbook"];
}

function deepSubjectText(subject: DeepSubject): string {
  return [
    `标题：${subject.title}`,
    `类型：${subject.type}`,
    `摘要：${subject.summary}`,
    // M3.8: most of a card's substance moved out of `summary` and into `summary_points` (see
    // queries.ts's ILIKE fix) -- without this, deep analysis would start from just the ~120-char
    // lead instead of the full card description.
    `摘要要点：${(subject.summary_points ?? []).length ? (subject.summary_points ?? []).map((p) => `**${p.label}。** ${p.text}`).join(" ") : "（无）"}`,
    `标签：${subject.tags.join(", ") || "（无）"}`,
    `已有来源链接：${subject.source_url ?? "（无）"}`,
    `Playbook：${JSON.stringify(subject.playbook)}`
  ].join("\n");
}

/** Prompt for the `plan` step: 4-5 search queries covering docs / repo / word-of-mouth / alternatives. */
export function deepPlanPrompt(subject: DeepSubject): string {
  return [
    "你在为个人 agent 能力库里已经建档的一张卡片做「深度分析」，第一步是规划检索式。",
    deepSubjectText(subject),
    "请给出 4–5 条搜索检索式（queries，最多 5 条，多于 5 条会被拒绝重写），覆盖以下四个方向，每个方向至少覆盖到（不要求一一对应，但整体要覆盖）：",
    "1）官方文档/官网/仓库 README；2）代码仓库本身（issues、release、star 数等）；3）讨论区与口碑（Reddit、Hacker News、中文社区、博客评测等）；4）与同类替代方案的对比。",
    "每条检索式是一句可直接丢进搜索引擎的查询词，不要写成问题，不要重复。"
  ].join("\n\n");
}

/** Prompt for the first `synthesize` pass: merge raw search results into grounded facts. */
export function deepFactsPrompt(subject: DeepSubject, sources: DeepSource[]): string {
  return [
    "你在为个人 agent 能力库的一张卡片做深度分析，现在是第一步「事实归并」：把下面的联网检索结果提炼成一条条客观事实，供下一步写成最终结论使用。",
    deepSubjectText(subject),
    sources.length
      ? `联网检索结果（编号从 0 开始，对应下面的下标）：\n${sources.map((s, i) => `[${i}] ${s.title} ${s.url}`).join("\n")}`
      : "联网检索结果：无（本次所有检索式都没有找到结果）。",
    "facts 给出最多 40 条事实，每条不超过 300 字；每条事实必须能在上面某个编号的检索结果里找到依据，source 填该结果的下标（从 0 开始的整数）；如果某条是你的合理推断而非直接来自某个检索结果，source 填 null，但不要编造具体的人名、数字、日期、案例这类看似确凿的细节。检索结果为空，或某个方向确实没找到东西，facts 里就不要为那个方向编造事实——宁可少写。"
  ].join("\n\n");
}

/** Prompt for the second `synthesize` pass: compose the final, scannable DeepAnalysis card. */
export function deepSynthesizePrompt(subject: DeepSubject, sources: DeepSource[], facts: string[]): string {
  return [
    "你在为个人 agent 能力库的一张卡片做深度分析，现在是第二步「成文」：基于下面已经归并好的事实和原始检索结果，写成一张简短、可扫读的深度分析卡片。绝对不要写成长篇大论，每个字段都有严格的字数上限，超过会被拒绝重写。",
    deepSubjectText(subject),
    facts.length ? `已归并的事实：\n${facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}` : "已归并的事实：无。",
    sources.length
      ? `原始检索结果（编号从 0 开始）：\n${sources.map((s, i) => `[${i}] ${s.title} ${s.url}`).join("\n")}`
      : "原始检索结果：无。",
    "请输出 DeepAnalysis：headline 是不超过 40 字的一句话结论；architecture 是 { summary ≤ 80 字, points：3–5 条，每条 ≤ 40 字 }，说明这个能力大致怎么构建/运作；implementation 同样是 { summary ≤ 80 字, points：3–5 条，每条 ≤ 40 字 }，说明落地/接入的关键步骤；use_cases 给 3–5 条 { title ≤ 20 字, detail ≤ 60 字 } 的具体应用场景；feedback 给 { positive: 0–3 条, negative: 0–3 条 } 的口碑要点，每条是 { text ≤ 40 字, source }，只写检索结果里真实出现过的评价，没有就留空数组。",
    "feedback 每条的 source：这条评价来自某个具体检索结果时，填你自己输出的 sources 数组里的下标（从 0 开始）；只是综合印象、说不出具体出处时，必须填 null。绝不能为了把 source 填上就随便挑一个下标——宁可填 null。",
    "risks 给 2–4 条风险/局限，每条 ≤ 50 字。",
    "sources 是你在上面这些字段里实际引用到的检索结果，按你自己的顺序重新列出 { title, url }（可以是原始检索结果的子集，不要求全部收录，也不要新增没出现过的链接）。",
    "cases 给 0–4 条 { title ≤ 30 字, detail ≤ 60 字, source } 的具体案例/落地实例；source 必须是上面你自己输出的 sources 数组里的下标（从 0 开始），必须是真实在检索结果里找到的案例，绝不能编造；如果检索结果里确实没有找到任何公开案例，cases 必须是空数组，不要为了凑数编造。"
  ].join("\n\n");
}

// --- Enrichment (M3.7) ------------------------------------------------------------------
// See lib/analysis/enrich.ts. Round 1 (reasonPrompt above) is cheap triage and never opens the
// card's own canonical URL; round 2 runs once a card is kept, opens that source for real, and
// rewrites the card so its summary describes the capability instead of narrating the analysis.

/** The subset of an existing CapabilityCard an enrichment run rewrites from. */
export interface EnrichSubject {
  title: string; type: CapabilityType; usage: "integrate" | "reference"; summary: string;
  summary_points: Card["summary_points"];
  signals: string[]; playbook: Card["playbook"]; tags: string[]; source_url: string | null;
  open_questions: string[];
  /**
   * True when `suggestion_by = 'human'` (a human already set type/usage/tags via 改建议 --
   * lib/library/actions.ts's editSuggestion). Told to the model so it doesn't spend effort
   * trying to reclassify a card whose type/usage/tags are pinned back to their stored values
   * regardless of what it outputs (see enrich.ts's enrichCardSchemaFor).
   */
  pinned: boolean;
}

/** Canonical fetch text handed to the model, capped well below canonical.ts's own 512 KiB read cap so the prompt stays a reasonable size. */
const CANONICAL_TEXT_PROMPT_CHARS = 6000;

function canonicalPromptText(canonical: CanonicalResult): string {
  if (!canonical) {
    return "抓取来源：未能抓取到来源页面内容（可能是没有来源链接、页面不可达，或抓取失败）。请只依据下面的补充调研结果和原有卡片内容改写，不要编造这个来源本可能有的内容。";
  }
  const text = canonical.text.slice(0, CANONICAL_TEXT_PROMPT_CHARS);
  if (canonical.kind === "repo") {
    const f = canonical.facts;
    const factsLine = [
      f.repo_url ? `repo_url: ${f.repo_url}` : null,
      f.stars != null ? `stars: ${f.stars}` : null,
      f.last_update ? `last_update: ${f.last_update}` : null,
      f.license ? `license: ${f.license}` : null,
      f.homepage ? `homepage: ${f.homepage}` : null
    ].filter(Boolean).join("；") || "（GitHub API 未返回可用字段）";
    return `抓取来源（GitHub 仓库 ${canonical.url}）：\n客观事实（权威，来自 GitHub API，source_facts 里对应字段直接采用，不要自己再猜或改写出不一致的数字）：${factsLine}\nREADME/描述正文（已截断）：\n${text || "（空）"}`;
  }
  return `抓取来源（网页 ${canonical.url}，标题：${canonical.title || "（无标题）"}）：\n正文（已截断）：\n${text || "（空）"}`;
}

/** Prompt for the enrichment pass' single rewrite ("reason") step. */
export function enrichPrompt(subject: EnrichSubject, canonical: CanonicalResult, searchResults: Array<{ question: string; sources: SearchResult["sources"] }>): string {
  return [
    `你在为个人 agent 能力库里已经建档、判定为 keep 的一张卡片做「补充调研」重写：不是从零分析，而是基于已抓取到的权威来源和补充检索，把卡片改写得更准确、更贴近能力本身。${CAPABILITY_TYPE_DEFINITIONS}`,
    subject.pinned
      ? `硬性约束：这张卡片的 type/usage/tags 已由人工确定（type=${subject.type}、usage=${subject.usage}、tags=${subject.tags.join(", ")}），本次改写必须原样使用这三项，不得改判；playbook 必须按这个 type/usage 的形状组织内容。`
      : "",
    `原有卡片：\n标题：${subject.title}\n类型：${subject.type}\n用途：${subject.usage}\n摘要：${subject.summary}\n摘要要点：${subject.summary_points.length ? subject.summary_points.map((p) => `**${p.label}。** ${p.text}`).join(" ") : "（无）"}\n价值信号：${subject.signals.join("；")}\n标签：${subject.tags.join(", ")}\nPlaybook：${JSON.stringify(subject.playbook)}\n来源链接：${subject.source_url ?? "（无）"}`,
    subject.open_questions.length ? `第一轮遗留的待核实问题：${subject.open_questions.join("；")}` : "第一轮没有遗留待核实问题。",
    canonicalPromptText(canonical),
    searchResults.length
      ? `针对待核实问题做的补充检索结果：\n${searchResults.map((r) => `问题「${r.question}」：\n${r.sources.length ? r.sources.map((s, i) => `[${i + 1}] ${s.title} ${s.url}\n${s.content}`).join("\n") : "（无结果）"}`).join("\n\n")}`
      : "本次没有做补充检索（没有遗留问题，或已直接从抓取来源确认）。",
    [
      "请重新输出改写后的卡片字段：",
      subject.pinned ? "" : "type 与 usage 按上面的类型定义与 integrate（可直接拿来用）/reference（值得借鉴后自研）之间重新判断；",
      "summary 是引子：一句话（≤ 120 字）说明这个能力是什么，不展开细节，细节交给 summary_points；只写关于能力的事实性描述，绝不能复述你是怎么核实/抓取/搜索的，禁止出现「经核实」「未直接证实」「抓取失败」这类过程叙述占据正文；来源是否可信、有没有核实到，只放进 signals 里恰好一条，不得写进 summary；",
      "summary_points 给 3–5 条 `{ label, text }`：label 是不超过 8 字的短标签（如「定位」「适用场景」「限制」「用法」），text 是不超过 60 字的一句说明句，呈现为 `**label。** text` 的效果；每条只讲一件事——它解决什么问题、怎么用、适合谁、边界/局限在哪等，绝不能把一整段话塞进一条 point，也不能让多条 point 重复同一件事；这部分承接 summary 留白的细节，合起来才是完整的能力说明；",
      "signals 给 2–3 条价值信号，其中恰好一条专门讲来源可信度/是否已核实，其余讲解决什么场景、适用边界等；",
      "playbook 按 usage/type 给可执行内容：integrate 给 install 命令、repo、prompt 全文；reference 给借鉴要点；experience 类型必须把核心内容本身写进 content；",
      subject.pinned ? "" : `tags 给 1–6 个标签，规则同第一轮：必须是英文小写单词或用连字符连接的短语，不能是中文，不能是 ${RESERVED_TAGS.join("、")} 这类类型/用途词；接入方式明确时使用 ${INTERFACE_TAGS.join("、")} 中的固定标签；已有贴切的标签要复用；`
    ].filter(Boolean).join(""),
    `score 给这个能力对 Joey 的 AI 价值打 1–5 分整数，${SCORE_RUBRIC}score_reason 用一句不超过 80 字的中文说明打分依据。`,
    "source_facts 是关于来源的客观事实（repo_url、stars、last_update、license、homepage）：只能填写上面「抓取来源」或「补充检索结果」中明确出现的内容，不能推测、不能凭经验填写；某一项没有明确出现就留空。",
    "open_questions 列出改写后仍然存在、需要进一步核实的问题（0–3 条，每条 ≤ 30 字）：把第一轮遗留问题中，这次抓取/检索已经解决的去掉，仍未解决的保留，也可以基于这次新看到的信息发现新的疑问；已经解决就不要再列进去，宁可留空也不要为了填满硬凑。"
  ].filter(Boolean).join("\n\n");
}
