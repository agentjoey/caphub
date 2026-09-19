# A/B spike 结果（source: web）

| pipeline | runs | done | failed | 平均耗时 | 平均 tokens/run | 输入 tokens | 输出 tokens | 失败尝试 tokens | 成本 (USD) | 成本/run (USD) |
|---|---|---|---|---|---|---|---|---|---|---|
| minimax | 0 | 0 | 0 | 0.0 s | 0 | 0 | 0 | 0 | $0.0000 | n/a |
| mixed | 5 | 5 | 0 | 16.6 s | 8929 | 39716 | 4931 | 0 | n/a | n/a |
| minimax_tavily | 5 | 5 | 0 | 22.3 s | 8959 | 39549 | 5248 | 5759 | n/a | n/a |

平均 tokens/run 与成本/run 按到达 done 或 failed 的 run 计（含失败尝试）；成本按 SPIKE_PRICE_<PROVIDER>_IN/_OUT（USD / 百万 token）计算，未配置则为 n/a。

## 分步平均（成功步骤）

| pipeline | step | 耗时 | tokens |
|---|---|---|---|
| minimax | vision | 0.0 s | 0 |
| minimax | search | 0.0 s | 0 |
| minimax | reason | 0.0 s | 0 |
| mixed | vision | 7.1 s | 3335 |
| mixed | search | 3.2 s | 0 |
| mixed | reason | 4.2 s | 5594 |
| minimax_tavily | vision | 9.1 s | 3340 |
| minimax_tavily | search | 4.0 s | 0 |
| minimax_tavily | reason | 5.6 s | 4467 |

## 卡片(供 Human 打分 1-5)

| capture | pipeline | title | type | 建议 | conf | tags | 评分 |
|---|---|---|---|---|---|---|---|
| cap_2fc9b39872df5b02 | minimax_tavily | Refero Skill：用设计参考驱动 AI 建站 | skill | keep | 0.78 | design-reference, ai-website-builder, mcp, content-creation, reference-first, ui-craft |  |
| cap_2fc9b39872df5b02 | mixed | Refero Styles：为AI建站提供DESIGN.md风格参考 | skill | keep | 0.70 | agent-skills, content-creation, claude-code |  |
| cap_588ee306b54ebe55 | minimax_tavily | Marketing skills for AI agents (50 CRO/SEO/copy skills) | skill | keep | 0.90 | agent-skills, content-creation, marketing, open-source, claude-code, seo |  |
| cap_588ee306b54ebe55 | mixed | coreyhaines31/marketingskills：50 项 AI 营销技能集 | skill | keep | 0.82 | marketing, agent-skills, seo, claude-code, open-source |  |
| cap_68cbcba61e794fea | minimax_tavily | text-to-cad：文本生成CAD/3D模型的Agent技能库 | skill | keep | 0.88 | cad, 3d-modeling, agent-skills, build123d, open-source, python |  |
| cap_68cbcba61e794fea | mixed | text-to-cad：面向 agent 的 CAD/机器人技能库 | skill | keep | 0.82 | agent-skills, cad, 3d-modeling, build123d, open-source, claude-code |  |
| cap_cd70bc8f92337836 | minimax_tavily | HyperFrames：HTML转视频的AI Agent视频渲染框架 | skill | keep | 0.92 | video-generation, agent-skills, open-source, claude-code, content-creation |  |
| cap_cd70bc8f92337836 | mixed | HyperFrames：HeyGen 开源的 HTML 转视频渲染框架 | skill | keep | 0.75 | video-generation, agent-skills, open-source, claude-code, content-creation |  |
| cap_de0fb747f67fea8a | minimax_tavily | Meetily 本地AI会议助手开源项目 | skill | discard | 0.62 | open-source, meeting-assistant, local-ai, speech-to-text, rust |  |
| cap_de0fb747f67fea8a | mixed | Meetily：本地离线 AI 会议纪要开源助手 | skill | keep | 0.78 | open-source, meeting-notes, speech-to-text, local-llm, rust |  |