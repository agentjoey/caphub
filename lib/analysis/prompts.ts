import type { Extraction, SearchResult } from "./card";
import type { Material } from "./material";

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
  similar: Array<{ id: string; title: string; tags: string[] }>; existingTags: string[];
}): string {
  const materialText = input.material.kind === "text" ? input.material.text
    : input.material.kind === "url" ? `URL: ${input.material.url}\n页面正文：${input.material.text ?? "（抓取失败）"}`
    : `（图片，见视觉提取结果）`;
  return [
    "你在为一个个人 agent 能力库做评估与建档。能力类型：skill（可安装/可执行的技能）、experience（做法/教训，需保留核心内容本身）、plugin、prompt、other。",
    `原始输入：\n${materialText}`,
    input.extraction ? `视觉提取结果：\n${JSON.stringify(input.extraction)}` : "",
    input.sources.length ? `联网来源（已截断）：\n${input.sources.map((s, i) => `[${i + 1}] ${s.title} ${s.url}\n${s.content}`).join("\n\n")}` : "联网来源：无",
    input.similar.length ? `库里已有的相似能力（判断是否重叠）：\n${input.similar.map((s) => `- ${s.title} [${s.tags.join(", ")}]`).join("\n")}` : "库里没有相似能力。",
    `已有标签（优先复用）：${input.existingTags.join(", ") || "（空）"}`,
    "请输出 CapabilityCard：title ≤ 30 字的一句话；type；summary 是对整个分析的完整摘要（结论 + 依据，≤ 300 字）；signals 给 2–3 条价值信号（如解决什么场景、与库内谁重叠、来源可信度）；suggested_verdict 与 suggested_reason；confidence 是你对该建议的把握（0–1）；usage 在 integrate（可直接拿来用）与 reference（值得借鉴后自研）之间选；playbook 按 usage/type 给可执行内容：integrate 给 install 命令、repo、prompt 全文；reference 给借鉴要点；experience 类型必须把核心内容本身写进 content；tags 1–6 个小写标签；source_url 给最可信的来源链接或 null。"
  ].filter(Boolean).join("\n\n");
}
