# Prompt 原文独立保存 — 验证记录（2026-09-22）

设计：`docs/superpowers/specs/2026-09-22-verbatim-prompts-design.md`；计划：`docs/superpowers/plans/2026-09-22-verbatim-prompts.md`。

范围：prompt 原文由代码从投递内容逐字摘取，存独立列 `capabilities.prompts`（`[{ text }]`），模型不写；截图走视觉逐条抄录，文字 / 网页由 reason 只给首尾锚点、代码截取原文；定位失败或 prompt 卡没摘到原文进 Review；web 与 Mini 详情页新增「Prompt 原文」面板；MCP `get_capability` 返回 `prompts`。迁移 014。

## 上线

| 步骤 | 结果 |
|---|---|
| 临时 Neon branch `verbatim-prompts-verify`：迁移 014 跑两遍 | 第一遍 applied，第二遍空；90 张卡、`capability_search_text` 一个重载、90 条全文向量、GIN 索引在 |
| 临时 branch：回填预演（dry-run → apply → 再 apply） | 11 张填入 / 22 张迁移 / 2 张待定；第二遍 0 变更；`updated_at` 未动 |
| 临时 branch：PRM-0027/0028 中英拆分预演 | 各 2 条，两段长度 + 换行 = 原长度（1173 / 1245），文字未改 |
| 本地 `localhost:3100`（临时 branch）截图 1440 / 390 | web + Mini 详情「Prompt 原文」在「怎么用」之前、换行保留、无横向溢出；空「怎么用」不渲染；web Review 两种提示正常。截图 `.agent/screens/verbatim-prompts/` |
| 生产迁移 014（worker 空闲时） | applied；90 张卡全文向量重建、GIN 索引在、函数一个重载 |
| 合并到 main 并推送（`0c5a286..8fd5722`） | web + worker 部署 SUCCESS |
| 生产回填 `--apply`（部署后） | 填入 11 · 迁移 22 · 待定 2 · 跳过 0；重跑 0 变更 |
| PRM-0027 / 0028 按中英换行拆成两条 | 各 2 条，长度核对一致 |
| PRM-0024 重跑分析（Joey 授权的真实模型调用） | 视觉抄录出 1 条原文，`prompt_unresolved = 0`，仍为保留 |
| 删除临时 branch | 已删除 |

回填顺序定为「迁移 → 部署 → 回填」：回填可重跑，且新旧代码都兼容新 schema；先部署可避免旧 worker 在窗口期写入的卡漏回填。

## Joey 的决定

- 22 张技能 / 工具卡里分析模型写的「用法 prompt」（不是投递原文）：保留，迁到 `playbook.usage_prompt`，在「怎么用」里以「用法示例（AI 生成）」展示，与「Prompt 原文」区分（Task 11）。
- PRM-0027 / 0028：中英两版按换行拆成两条。
- PRM-0024：重跑分析补原文。PRM-0010（GPT Image 2 提示词合集链接）投递内容里没有 prompt，保持为空。

## 已知限制 / 遗留

- 截图来源的原文是视觉模型逐字抄录，代码无法逐字核对（例：PRM-0024 抄录为「跟随手指数放大」，疑似多一个「数」，需对照原图人工确认）。
- 网页来源的原文与抓取到的正文逐字一致，但抓取时会合并空行、去掉行首缩进。
- 锚点定位取「起点之后第一个匹配的结尾」，若结尾短语在 prompt 内部重复会截短（仍是原文片段）。
- **既有问题（非本次引入）**：`/mini/review` 在有「文字投递」待决卡时 500——`CardSummary`（服务端组件）调用了 `"use client"` 文件里的 `captureTextExcerpt`。另行修复。
- 列表查询会带出完整 prompt 文本；库规模小，暂不优化。
