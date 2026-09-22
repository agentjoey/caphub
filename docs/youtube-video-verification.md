# YouTube 视频投递分析 — 验证记录（2026-09-22）

设计：`docs/superpowers/specs/2026-09-22-youtube-video-design.md`；计划：`docs/superpowers/plans/2026-09-22-youtube-video.md`；实测与预演：`docs/spike-video.md`。

范围：YouTube 链接投递识别为视频素材；YouTube Data API 取元数据（`fetch` 步骤）；Gemini `gemini-3.8-flash` 经 `generateContent` + `fileData.fileUri` 看视频（`vision` 步骤，视频预算 60 万 token、超时 300 秒、超过 90 分钟或时长未知只看前 90 分钟）；失败回退为仅元数据分析并强制进 Review；详情页「视频」面板与关键片段、列表缩略图。无数据库迁移。

## 上线

| 步骤 | 结果 |
|---|---|
| 实测（5 视频 × 2 模型 × 2 模式） | 选定 3.8 Flash + 默认处理；见 `docs/spike-video.md` |
| 最终整分支评审 → 修复 7 项（长视频重试超预算、时长未知不截断、缺失测试等）→ 复查 | 全部修复；1414 测试、typecheck、lint、build 通过 |
| 临时 Neon branch + 本地 worker（关闭 Telegram / retention）真实预演 5 条 | 5/5 生成有效卡片（第 5 条首次 DeepSeek 输出不合格，重跑成功）；截图 web 1440 / Mini 390 无溢出 |
| Railway worker 变量核对 | `GEMINI_API_KEY`、`YOUTUBE_API_KEY` 已配；`GEMINI_VIDEO_MODEL` 用默认值 |
| 合并到 main 并推送（`cf675c1..0b78ad7`） | web + worker 部署 SUCCESS |
| 生产重跑 Joey 投递的 5 条视频 | 5/5 完成，每条 fetch → vision（Gemini）→ search → reason |
| 删除临时 branch | 已删除 |

## 生产结果

| 卡片 | 类型 | 裁决 | 置信度 | prompt 原文 | 视频 token |
|---|---|---|---|---|---|
| Jev 极速决策模型与配套 Coding Agent Skill | skill | 待定 | 0.70 | 0 | 93,456 |
| TypeSafe Jev：只做决策不生成文本的 System One 模型 | model | 待定 | 0.66 | 3 | 40,058 |
| Laya：开源的 System 1 类型化决策模型（MDL-0073） | model | 保留（Joey 手动） | 0.78 | 3 | 72,020 |
| 用 GPT-6 Astra 做获奖级网页与 3D 交互设计的三条提示词 | prompt | 待定 | 0.62 | 3 | 39,103 |
| 按任务复杂度路由 LLM 档位以控配额消耗的实测经验 | experience | 待定 | 0.72 | 1 | 29,918 |

这 5 条在旧流程下全部被自动丢弃；现在 4 条待 Review、1 条已保留。

## 已知限制 / 遗留

- 只支持公开 YouTube 视频（Google 端取视频）；私有、下架、地区限制走元数据回退并进 Review。
- 视频里的 prompt 原文是 Gemini 抄录，无法逐字核验（与截图相同）。
- 结构化调用新增「第二次尝试放不进预算就不重试」，对所有分析步骤生效（首次用量超过预算一半时不再重试）。
- 放置未修的小问题：模型名未做 URL 编码、带尾点的域名不识别、部署时正在分析的视频会被重跑一次。
- 既有问题（非本次引入）：`/mini/review` 在有「文字投递」待决卡时 500。
