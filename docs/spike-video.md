# 视频（YouTube）理解实测（2026-09-22）

目的：为「以 YouTube 链接为输入，提取视频关键信息并建档」选模型与调用方式。

## 方法

- 样本：Joey 投递的 5 个 YouTube 视频（中文 1 个、英文 4 个；时长 5:21 – 16:55）。现有流程把这 5 条**全部自动丢弃**——网页抓取只拿到播放器配置代码。
- 元数据：YouTube Data API v3（`videos.list`，snippet + contentDetails）拿标题、频道、发布时间、时长、简介，一并放进提示词。
- 调用：Gemini `POST /v1beta/interactions`，`input = [{ type: "video", uri: <YouTube URL> }, { type: "text", text: <提示词> }]`；要求只输出 JSON（what / visible_text / commands / prompts / source_hints / questions / key_moments）。
- 组合：`gemini-3.8-flash` 与 `gemini-3.5-flash-lite` × 默认处理（static）与智能模式（`processing: "agentic"`），共 20 次调用。本地经 `railway run -s worker` 注入密钥，未打印。
- 脚本为一次性代码，未入库。

## 结果

| 组合 | 成功 | 平均耗时 | 最长 | 平均 token | 最多 | 链接 | 命令 | prompt 原文 |
|---|---|---|---|---|---|---|---|---|
| 3.8 Flash · 默认 | 5/5 | 21.1 s | 47.3 s | 55,952 | 95,033 | 6 | 10 | 19 |
| 3.8 Flash · 智能 | **3/5** | 32.4 s | 44.1 s | 66,588 | 103,166 | 10 | 9 | 18 |
| 3.5 Flash-Lite · 默认 | 5/5 | 14.1 s | 36.1 s | 55,397 | 94,726 | 3 | 11 | 6 |
| 3.5 Flash-Lite · 智能 | 5/5 | 15.3 s | 32.9 s | 13,489 | 24,960 | 0 | 1 | 5 |

（「链接」= source_hints 里的 URL / github 地址数；「prompt 原文」= 抄录出的提示词条数。JSON 全部可解析。）

观察：

- **默认处理的 token 就是视频时长**：约 91 token/秒（16:55 视频 92,288 个视频 token），与文档「低分辨率约 100 token/秒」一致；输入价格按视频 token 计。
- **3.8 Flash · 默认质量最好且稳定**：仓库地址（如 `github.com/NandhaKishorM/laya`、`gregpr07/jev-ultrafast`）、安装命令（`claude plugin marketplace add typesafe-ai/skills` 等）、画面里的完整英文提示词都能抄出；中文视频同样有效。
- **智能模式不稳**：3.8 Flash 有 2/5 次在第 60 秒被服务端断开连接（`UND_ERR_SOCKET`）；成功的几次 token 反而更多（思考 token 计入，最高 103k），没有体现文档所说的省 token（样本都是 20 分钟内的短视频，省 token 主要针对长视频）。智能模式能配合 YouTube 链接使用（文档未写，实测确认）。
- **3.5 Flash-Lite · 智能** token 最少，但几乎拿不到链接和命令，漏掉了中文视频里的安装命令与全部 prompt。
- **3.5 Flash-Lite · 默认** 速度最快，但链接只有 3.8 的一半，prompt 原文少很多。
- 抄录有细微差异（大小写、个别用词），与截图抄录一样无法逐字核验，属于模型抄录的上限。

## 结论

- 用 **`gemini-3.8-flash` + 默认处理**。按视频输入 $0.75 / 百万 token（2026 年内价格；2027-01-01 起 $1.50）计，17 分钟视频约 $0.07，5–7 分钟视频约 $0.03。模型名做成配置项。
- 暂不用智能模式：稳定性不够；长视频（> 30 分钟）再单独评估。
- YouTube Data API 的简介很有价值：链接、赞助信息、频道名都在里面，且免费额度充足。
- `processing: { type: "static", fps, end_offset }` 形式的请求被 API 以 `Invalid input at 'input[0].processing'` 拒绝（YouTube 链接），裁剪片段的参数写法需另行确认；超长视频的处理方式在设计中定。

## 上线前预演（2026-09-22，临时 Neon branch `youtube-video-verify`）

本地 worker（`railway run -s worker`，`DATABASE_URL` 指向临时 branch，`TELEGRAM_ENABLED=false`、`RETENTION_ENABLED=false`）对 Joey 投递的 5 个视频各重跑一次（旧流程下这 5 条全部被自动丢弃）。实现走 `generateContent` + `fileData.fileUri`（非实测时的 interactions 接口），`gemini-3.8-flash`，默认 temperature。

| 视频 | 新卡片 | 视频 token | 看视频耗时 | prompt 原文 | 裁决 |
|---|---|---|---|---|---|
| Jev 实测（中文，16:55） | Jev：TypeSafe 极速类型化决策模型与官方 Agent Skill；来源 typesafe.ai 官方博客 | 93,456 | 10.9 s | 0 | 待定（0.72） |
| Jev explained in 7min | Jev：输出概率分布的非自回归决策模型 | 40,058 | 6.8 s | 2 | 待定（0.60） |
| Open Source, Faster Jev is HERE | Laya：可本地运行的非自回归 System 1 决策模型；来源 github.com/NandhaKishorM/laya，`pip install laya` | 72,020 | 16.0 s | 4 | 待定（0.76） |
| GPT 6 Astra Web Design | GPT-6 Astra 网页设计提示词三则（prompt 类型） | 39,103 | 11.7 s | 3 | 待定 |
| Should you use Astra Ultra… | 首次：视频步骤成功，DeepSeek 分析两次输出不合格 → run 失败；重跑成功 | 29,918 | 11.8 s | 1 | — |

- 每条都记录了 `fetch`（YouTube）→ `vision`（Gemini）→ `search` → `reason` 四步；视频 token ≈ 时长 × 91，与实测一致；单条视频输入约 $0.02–0.07。
- 置信度都低于 0.8，按正常规则进 Review（不是视频读取失败导致的强制待定）。
- 第 5 条首次失败在 DeepSeek 分析步骤（与视频功能无关的既有失败方式），重跑即成功。
- 截图 `.agent/screens/youtube-video/`：详情页「视频」面板（标题、频道 · 时长、关键片段带时间点链接）、Prompt 原文、「用法示例（AI 生成）」、列表页 YouTube 缩略图；web 1440 / Mini 390 均无横向溢出。
