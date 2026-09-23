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

## 修正：视频卡只总结视频本身（2026-09-23）

Joey 反馈：视频卡的总结应是视频本身的内容，而不是按话题搜索得来的结果（只对话题感兴趣时会用截图投递）。原因三处：分析时混入 Tavily 搜索结果；保留后「补充调研」按网页重写整张卡（如 Laya 卡混入 GitHub 基准数据）；视频抽取太薄。

- 视频抽取新增 `content_points`（视频讲了 / 演示了什么，带时间点）。
- 分析提示词 `VIDEO_CONTENT_ONLY`：title / summary / summary_points / playbook 及除来源可信度外的 signals 只依据视频内容与简介；联网来源只用于 source_facts 和来源可信度那一条（Joey 选择保留搜索）。
- 补充调研跳过 YouTube 投递，并清掉此前留下的 `enriched_at`；深度分析不受影响。
- 视频卡常被定为 experience，提示词补充 experience 的 playbook 形状，减少首轮输出不合格。
- 临时 branch 验证 2 条后上线（`f09fcb4`、`585fd8c`），生产重跑 5 条：总结全部改为视频内容（例：Laya 卡从 GitHub 基准数据改为视频里的贪吃蛇 23ms、Browser Use 查航班、Claude Code 移植演示），Laya 卡的补充调研标记已清除。

## 内容准确性核对（2026-09-23）

对 5 张视频卡里的数字类说法逐条截取原片片段，让 Gemini 逐字转写核对（必要时换 `gemini-3.5-flash` 交叉验证），约 9 万 token。

- **额度重置周期**：卡片写「每 6 小时重置」，Joey 指出实际是 5 小时。两个模型转写一致，原话是 "Because your usage resets every six hours"——视频作者说错，抽取忠实。按 Joey 的决定不加「视频称…」措辞。
- **其余 11 条数字**：全部能在原片找到出处（约一半来自画面文字）。小偏差：「减少 90% 协议调用」是对画面「1092 → 101 次」的概括；「39ms」实为画面 `39.5 ms`；「全天高强度设计任务消耗每周额度 5%–10%」中的「高强度」为模型添加，原话是 "use it for an entire day, and only use 5 to 10% of my entire weekly tokens"。

## 修正：视频运行调用上限 4 → 5（`54128bf`）

之前误报 5 条生产重跑全部成功：GPT-6 Astra 那条（`run_eebbd3d1e7caa01e`）实际因看视频、分析各需一次纠错重试，4 次调用上限不够而以 BUDGET 失败，卡片停留在没有「视频要点」的旧版本（当时按卡片 `run_id` 读到的是旧分析）。看视频第一次失败的原因是 `key_moments` 用了 `content_points` 的字段名 `point`。修复：视频运行上限提到 5 次，提示词写明两个列表的字段名。重跑后该卡恢复正常：8 条视频要点、内容只来自视频、保留裁决不变。

## 修正：视频的 prompt 只收可复用的指令（`a1be461`、`5c273c3`）

Joey 指出 MDL-0078 的「Prompt 原文」是 11 条无用文本：实为作者在 Jev Playground 里喂给被测模型的测试输入（退款判断、分诊、路由、审核的样例文本）。原因是视频抽取把「输进 AI 输入框的文字」都当提示词。修复：只收作者为产出演示结果写给 AI 模型 / agent、可复用的完整指令；不收测试输入、样例数据、简短跟进语、界面文字、命令和重复版本。

重跑 3 张卡时，Caleb 那张（0079）的看视频步骤连续两次不合格：Gemini 给 `key_moments` 写了 `content_points` 的字段名 `point`，提示词写明字段名、纠错重试点名错误都没用。改为两个列表统一用 `{ t, point }`，页面读取兼容旧的 `note`。

结果（都按最新一次运行核对）：

| 卡片 | 之前 | 之后 |
|---|---|---|
| Jev 实测（0078，类型改判为经验） | 11 条测试输入 | 0 条；视频要点 11 条 |
| Laya（0073） | 3 条（含 2 条浏览器代理演示任务） | 1 条：给 Claude Code 的移植指令；视频要点 9 条 |
| Caleb（0079） | 同一条 Junie 提示词出现两次 + `Implement the suggested plan` | 1 条 Junie 提示词；视频要点 9 条、关键片段 5 个 |

GPT-6 Astra（3 条建站提示词）与 Codex 档位对比（1 条实验提示词）本来就正确，未重跑。
