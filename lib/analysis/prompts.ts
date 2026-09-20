import { RESERVED_TAGS, type CapabilityType, type Extraction, type SearchResult } from "./card";
import type { Material } from "./material";
import type { Scenario } from "./scenarios";
import { scenariosPromptList } from "./scenarios";

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
  "能力类型定义：skill（可安装/可执行的技能，如脚本、CLI、agent skill、可复用的工作流）；experience（一次具体实践得到的做法/教训/复盘，需要保留核心内容本身而不只是链接）；plugin（面向某个宿主平台——IDE、浏览器、聊天客户端等——的可安装插件/扩展）；prompt（可直接复用的提示词本身，单条提示词或提示词合集/库都算）；tool（可独立运行的应用/工具/框架：自带运行入口，不依附某个宿主，如 CLI 应用、桌面或 Web 应用、本地服务、agent 运行框架）；other（以上五类都不合适时才用，不是默认兜底）。skill 与 tool 的边界：skill 是被你或 agent 调用的可复用技能/工作流/脚本，tool 是自己就能跑起来的成品应用或框架。tool 与 plugin 的边界：plugin 必须插进某个宿主平台，tool 不需要宿主、自己就是入口。合集/库按它收录的内容定型，不要因为「是个合集」就归为 other：提示词合集/库记为 prompt，skill 合集/库记为 skill，以此类推。";

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
  similar: Array<{ id: string; title: string; tags: string[] }>; existingTags: string[]; scenarios: Scenario[];
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
    input.similar.length ? `库里已有的相似能力（判断是否重叠）：\n${input.similar.map((s) => `- ${s.title} [${s.tags.join(", ")}]`).join("\n")}` : "库里没有相似能力。",
    `已有标签（优先复用，找到贴切的就不要新造）：${input.existingTags.join(", ") || "（空）"}`,
    `候选应用场景（slug（中文名：关键词…））：${scenariosPromptList(input.scenarios)}`,
    "请输出 CapabilityCard：title ≤ 30 字的一句话；type；summary 是对整个分析的完整摘要（结论 + 依据，≤ 300 字）；signals 给 2–3 条价值信号（如解决什么场景、与库内谁重叠、来源可信度）；suggested_verdict 与 suggested_reason；confidence 是你对该建议的把握（0–1）；usage 在 integrate（可直接拿来用）与 reference（值得借鉴后自研）之间选；playbook 按 usage/type 给可执行内容：integrate 给 install 命令、repo、prompt 全文；reference 给借鉴要点；experience 类型必须把核心内容本身写进 content；" +
      `tags 给 1–6 个标签，每个必须是英文小写单词或用连字符连接的短语（如 web-scraping、time-series），不能是中文，不能是空格分隔的多词（"Web Scraping" 不合法，要写成 web-scraping），也不能是 ${RESERVED_TAGS.join("、")} 这类类型/用途词；已有贴切的标签要复用，不要为同一含义新造近义词；` +
      "scenarios 从候选应用场景的 slug 中选出 1–3 个这个能力最可能被用在的应用场景，按贴切程度排列，只能用给出的 slug，不要自造；" +
      "source_url 给最可信的来源链接或 null。",
    `score 给这个能力对 Joey 的 AI 价值打 1–5 分整数，${SCORE_RUBRIC}score_reason 用一句不超过 80 字的中文说明打分依据。`,
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
