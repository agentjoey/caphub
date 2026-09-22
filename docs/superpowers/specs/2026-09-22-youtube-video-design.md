# YouTube 视频投递分析 — 设计

日期：2026-09-22 · 状态：已批准（Joey，2026-09-22）· 实测：`docs/spike-video.md`

## 目标

以 YouTube 链接为输入，提取视频的关键信息与内容（画面 + 语音 + 元数据），分析后按现有流程建档。现状：视频链接只抓到播放器配置代码，Joey 投递的 5 个视频全部被自动丢弃。

## 已定决策

- 只做 YouTube；其他平台以后再说。
- 元数据用 YouTube Data API v3（`YOUTUBE_API_KEY`，已配在 Railway `worker`，已验证可用）。
- 看视频用 Gemini 经典接口 `POST /v1beta/models/{model}:generateContent`，`fileData.fileUri` 直接传 YouTube 链接（Google 端取视频，Railway 不下载）；模型 `gemini-3.8-flash`，默认处理（不用智能模式）；模型名为配置项 `GEMINI_VIDEO_MODEL`。
- 长视频看全长：视频分析单独给 600,000 token 预算；超过 90 分钟的只看前 90 分钟（`videoMetadata.endOffset: "5400s"`），并在卡片上注明。
- 投递入口（web / Telegram / MCP）不改；数据库不迁移。

## 1. 识别与元数据

`lib/analysis/material/youtube.ts`：

- `parseYouTubeUrl(url): string | null` —— 识别 `youtube.com/watch?v=ID`、`youtu.be/ID`、`youtube.com/shorts/ID`、`m.youtube.com/...`、`youtube.com/live/ID`、`youtube-nocookie.com/embed/ID`（https），返回 11 位视频 ID；其他返回 null。
- `fetchYouTubeMeta(videoId, apiKey, fetch): Promise<YouTubeMeta | null>` —— `videos.list?part=snippet,contentDetails`，返回 `{ title, channel, publishedAt, durationSec, description }`；ISO 8601 时长解析为秒；任何失败（无 key、HTTP 错误、无结果）返回 null，不抛。

`Material` 新增：

```ts
{ kind: "video"; platform: "youtube"; url: string /* https://www.youtube.com/watch?v=ID */; videoId: string; meta: YouTubeMeta | null }
```

`prepareMaterial`：`capture.kind === "url"` 且 `parseYouTubeUrl` 命中时返回 video 素材（不再抓网页）；元数据获取记为一条 `fetch` 步骤（provider `youtube`、model `data-api-v3`，output 为 meta 或 null）。——`prepareMaterial` 目前不记步骤，改为由 pipeline 在准备素材后记录。

## 2. 看视频（取代 vision 步骤）

- `StructuredInput` 新增 `video?: { url: string; endOffsetSec?: number }`；`RunStructuredRequest` 同步透传。
- `lib/providers/gemini-video.ts`：`createGeminiVideoCall({ apiKey, model, fetch? }): StructuredCall`，请求体：
  ```json
  { "contents": [{ "parts": [
      { "fileData": { "fileUri": "<url>" }, "videoMetadata": { "endOffset": "5400s" } },
      { "text": "<buildStructuredPrompt(input)>" } ] }],
    "generationConfig": { "responseMimeType": "application/json", "temperature": 0.2 } }
  ```
  （`videoMetadata` 仅在 `endOffsetSec` 有值时带上。）usage 取 `usageMetadata.promptTokenCount` / `candidatesTokenCount + thoughtsTokenCount`；文本取 `candidates[0].content.parts[].text` 拼接；JSON 解析失败按现有约定抛 `INVALID_OUTPUT`（带 raw 与 usage，走 runStructured 的纠错重试）；HTTP 错误用 `failureForHttpStatus`，detail 带状态码与响应片段（不含 key）。
- 抽取结构 `videoExtractionSchema = extractionSchema.extend({ key_moments: z.array(z.object({ t: z.string().regex(/^\d{1,2}:\d{2}(:\d{2})?$/), note: z.string().min(1).max(120) })).max(8).default([]) })`。
- `videoPrompt(meta, clipped)`：说明看画面 + 语音；字段含义同 `visionPrompt`（prompts 逐字、最多 20 条、按出现顺序）；附元数据（标题、频道、发布时间、时长、简介前 4000 字）；`clipped` 时注明只看了前 90 分钟。
- 预算：视频 run 使用 `new RunBudget({ maxCalls: 4, maxTokens: 600_000 })`；超时 `TIMEOUTS.video = 300_000`。
- 依赖：`PipelineDeps.video?: StructuredCall`；`createPipelineDeps` 在 `GEMINI_API_KEY` 存在时创建（所有 pipeline 模式都用 Gemini 看视频）；`MaterialDeps.youtubeApiKey`。

## 3. 失败回退

视频步骤抛出非 `BUDGET` / `ABORTED` 的错误（私有、下架、地区限制、Gemini 故障、未配置 Gemini key）时：不中断 run，extraction 为 null，继续搜索 + 分析（原始输入只有元数据与简介），分析提示词写明「视频内容未能读取」；最终裁决一律 `pending`（进 Review），并由提示词要求在 signals 里写一条「视频未能读取，仅依据标题与简介」。

## 4. 下游

- `searchQuery`：视频有 extraction 时同图片；没有时用 `meta.title`（再退回 url）。
- `reasonPrompt` 原始输入：`YouTube 视频：<url>\n标题 / 频道 / 发布 / 时长 / 简介` + 「视频内容提取结果」（extraction JSON）或「视频内容未能读取」；`clipped` 时要求在 signals 写明「只分析了前 90 分钟」。`prompt_locators` 对视频给空数组（原文来自视频抄录）。
- `collectPrompts`：`video` 与 `image` 相同，用 `extraction.prompts`；extraction 为 null 时 prompts 为空、unresolved 0。
- 相似度种子：`extraction.what ?? meta.title ?? url`。

## 5. 展示

- `getCapabilityDetail` 额外取本 run 的 `fetch`（provider `youtube`）与 `vision` 步骤输出，组成 `video: { videoId, title, channel, durationSec, clipped, failed, moments: Array<{ t, note }> } | null`（非视频卡为 null）。
- 新组件 `VideoSummary`（web + Mini 详情页，放在「一句话总结」之后）：标题 · 频道 · 时长；`clipped` 提示「只分析了前 90 分钟」；`failed` 提示「视频未能读取，仅依据标题与简介」；关键片段列表，每条时间点链接到 `https://www.youtube.com/watch?v=ID&t=<秒>s`（新标签页）。
- `CapturePreview` 对 YouTube 链接显示缩略图 `https://i.ytimg.com/vi/<ID>/hqdefault.jpg` + 链接。
- i18n 中英文案。

## 6. 配置

`envSchema` 增 `YOUTUBE_API_KEY`（optional）、`GEMINI_VIDEO_MODEL`（default `gemini-3.8-flash`）；`config.providers.youtubeApiKey`、`config.geminiVideoModel`。均非必填：没有 YouTube key 就没有元数据；没有 Gemini key 就走失败回退。

## 测试

全部不连真实服务：链接识别（各种形式、非 YouTube、http、畸形）；ISO 时长解析；元数据获取失败返回 null；Gemini 请求体（fileUri、endOffset 有无）、usage、JSON 失败、HTTP 错误；pipeline：视频正常路径（调用顺序 fetch → video → search → reason、预算 600k）、超 90 分钟带 endOffset、视频失败回退且裁决 pending、prompts 来自视频抄录；详情 video 组装；组件渲染与时间点链接；配置默认值。

上线前：临时 Neon branch + 本地 worker 用 Joey 投递的 5 个视频真实跑一遍（真实模型调用，已授权范围内）；本地 `localhost` 截图检查 web + Mini；然后部署（无迁移），重跑这 5 条生产卡（需 Joey 确认）。

## 不做

- 其他视频平台；下载视频；智能模式；字幕 API。
- 把视频元数据存成新列（从步骤输出读取即可）。
