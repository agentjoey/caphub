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
