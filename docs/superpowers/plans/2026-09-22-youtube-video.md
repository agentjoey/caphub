# YouTube 视频投递分析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** YouTube 链接投递后，用 YouTube Data API 取元数据、Gemini 直接看视频，产出抽取结果，走现有搜索 + 分析 + 裁决建档。

**Architecture:** `prepareMaterial` 把 YouTube 链接识别为 `video` 素材；pipeline 取元数据（记 `fetch` 步骤），再用新的 `StructuredCall`（Gemini `generateContent` + `fileData.fileUri`）跑「看视频」步骤（记为 `vision` 步骤），失败则回退为仅元数据分析并强制进 Review。下游 search / reason / prompts 按素材类型分支。详情页从步骤输出组装视频摘要。无迁移。

**Tech Stack:** Next.js 16.3.3 App Router · React 19 · pg · Zod 4 · Vitest

**Spec:** `docs/superpowers/specs/2026-09-22-youtube-video-design.md`（实测：`docs/spike-video.md`）

## Global Constraints

- 只识别 https 的 YouTube 链接；视频 ID 为 11 位 `[A-Za-z0-9_-]`。
- Gemini 端点：`https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`，header `x-goog-api-key`；视频以 `fileData.fileUri` 传 `https://www.youtube.com/watch?v=<ID>`。
- 默认模型 `gemini-3.8-flash`（配置 `GEMINI_VIDEO_MODEL`）。
- 视频 run 预算 `{ maxCalls: 4, maxTokens: 600_000 }`；超时 `TIMEOUTS.video = 300_000`；超过 5400 秒只看前 5400 秒（`videoMetadata.endOffset: "5400s"`）。
- 视频步骤失败（非 BUDGET / ABORTED）→ 不中断，extraction = null，裁决强制 `pending`。
- 元数据获取任何失败都返回 null，不抛。
- 不迁移数据库；步骤名只用已有的 `fetch` / `vision` / `search` / `reason`。
- 测试不连真实数据库 / 模型 / 网络（注入 fetch）；真实验证只在临时 Neon branch。
- 密钥只在 Railway；不打印、不入库、不写进日志 / 错误 detail。
- 写 Next.js 代码前读 `node_modules/next/dist/docs/` 相关指南（AGENTS.md）。
- 命令：`npm test`、`npm run typecheck`、`npm run lint`、`npx vitest run <path>`。
- 提交信息末尾两行：
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01X1WwWdSgWMqMQhpKGEfGZT`

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `lib/config.ts` (+test) | 改 | `YOUTUBE_API_KEY`、`GEMINI_VIDEO_MODEL` |
| `lib/analysis/material/youtube.ts` (+test) | 新建 | 链接识别、ISO 时长解析、元数据获取 |
| `lib/analysis/material/index.ts` | 改 | `video` 素材类型 |
| `lib/analysis/structured.ts` | 改 | `StructuredInput.video` 透传 |
| `lib/providers/gemini-video.ts` (+test) | 新建 | Gemini 看视频 `StructuredCall` |
| `lib/analysis/card.ts` (+test) | 改 | `videoExtractionSchema` |
| `lib/analysis/prompts.ts` (+test) | 改 | `videoPrompt`；`reasonPrompt` / `searchQuery` 视频分支 |
| `lib/analysis/prompt-locate.ts` (+test) | 改 | `collectPrompts` 视频分支 |
| `lib/analysis/pipeline.ts` (+test) | 改 | 元数据步骤、看视频步骤、预算、回退、裁决 |
| `lib/library/queries.ts` (+test 如有) | 改 | `CapabilityDetail.video` |
| `components/capability/video-summary.tsx` (+test) | 新建 | 视频摘要 + 关键片段 |
| `components/capability/capture-preview.tsx` | 改 | YouTube 缩略图 |
| `app/(chrome)/library/[id]/page.tsx`、`app/mini/library/[id]/page.tsx` | 改 | 挂 `VideoSummary` |
| `lib/i18n/dict-zh.ts`、`dict-en.ts`、`app/globals.css` | 改 | 文案、样式 |

---

### Task 1: 配置 + YouTube 链接识别与元数据

**Files:** Modify `lib/config.ts`, `lib/config.test.ts`; Create `lib/analysis/material/youtube.ts`, `lib/analysis/material/youtube.test.ts`; Modify `lib/analysis/material/index.ts`.

**Interfaces — Produces:**
- `Config.providers.youtubeApiKey?: string`；`Config.geminiVideoModel: string`（默认 `"gemini-3.8-flash"`）
- `export interface YouTubeMeta { title: string; channel: string; publishedAt: string; durationSec: number | null; description: string }`
- `export function parseYouTubeUrl(url: string): string | null`
- `export function parseIsoDuration(iso: string): number | null`
- `export async function fetchYouTubeMeta(videoId: string, apiKey: string | undefined, fetchFn?: typeof fetch, signal?: AbortSignal): Promise<YouTubeMeta | null>`
- `Material` 新增 `{ kind: "video"; platform: "youtube"; url: string; videoId: string; meta: YouTubeMeta | null }`；`prepareMaterial` 对 YouTube 链接返回 `meta: null` 的 video 素材（元数据由 pipeline 取，Task 4）。

- [ ] **Step 1: 配置测试（`lib/config.test.ts` 追加）**

```ts
it("reads YOUTUBE_API_KEY and defaults GEMINI_VIDEO_MODEL", () => {
  const base = { DATABASE_URL: "postgres://x" };
  expect(loadConfig({ ...base }, "script").geminiVideoModel).toBe("gemini-3.8-flash");
  const c = loadConfig({ ...base, YOUTUBE_API_KEY: "yt", GEMINI_VIDEO_MODEL: "gemini-3.5-flash-lite" }, "script");
  expect(c.providers.youtubeApiKey).toBe("yt");
  expect(c.geminiVideoModel).toBe("gemini-3.5-flash-lite");
  expect(loadConfig({ ...base, YOUTUBE_API_KEY: "" }, "script").providers.youtubeApiKey).toBeUndefined();
});
```

- [ ] **Step 2: 实现配置**：`envSchema` 加 `YOUTUBE_API_KEY: optional`、`GEMINI_VIDEO_MODEL: z.preprocess(unsetIfEmpty, z.string().default("gemini-3.8-flash"))`；`Config.providers` 加 `youtubeApiKey?: string`，`Config` 加 `geminiVideoModel: string`；`loadConfig` 返回对象对应填入。都不加进 `requiredFor`。

- [ ] **Step 3: youtube.ts 测试**

```ts
import { describe, expect, it, vi } from "vitest";
import { fetchYouTubeMeta, parseIsoDuration, parseYouTubeUrl } from "./youtube";

describe("parseYouTubeUrl", () => {
  it.each([
    ["https://www.youtube.com/watch?v=tYvu6IpSfiM", "tYvu6IpSfiM"],
    ["https://youtube.com/watch?v=tYvu6IpSfiM&t=42s", "tYvu6IpSfiM"],
    ["https://m.youtube.com/watch?v=tYvu6IpSfiM", "tYvu6IpSfiM"],
    ["https://youtu.be/tYvu6IpSfiM?si=FB-YBM4O1x617C_H", "tYvu6IpSfiM"],
    ["https://www.youtube.com/shorts/tYvu6IpSfiM", "tYvu6IpSfiM"],
    ["https://www.youtube.com/live/tYvu6IpSfiM?feature=share", "tYvu6IpSfiM"],
    ["https://www.youtube-nocookie.com/embed/tYvu6IpSfiM", "tYvu6IpSfiM"],
    ["https://www.youtube.com/embed/tYvu6IpSfiM", "tYvu6IpSfiM"]
  ])("%s → %s", (url, id) => expect(parseYouTubeUrl(url)).toBe(id));

  it.each([
    "http://youtu.be/tYvu6IpSfiM",
    "https://youtube.com/channel/UCAVDRj14A9W2Zix1Y5EUm7Q",
    "https://www.youtube.com/watch?v=short",
    "https://evil.com/watch?v=tYvu6IpSfiM",
    "https://youtube.com.evil.com/watch?v=tYvu6IpSfiM",
    "not a url"
  ])("rejects %s", (url) => expect(parseYouTubeUrl(url)).toBeNull());
});

describe("parseIsoDuration", () => {
  it("parses hours/minutes/seconds", () => {
    expect(parseIsoDuration("PT16M55S")).toBe(1015);
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("PT7M")).toBe(420);
    expect(parseIsoDuration("P1DT1S")).toBe(86401);
    expect(parseIsoDuration("garbage")).toBeNull();
  });
});

describe("fetchYouTubeMeta", () => {
  const item = { snippet: { title: "T", channelTitle: "C", publishedAt: "2026-09-20T00:00:00Z", description: "D https://github.com/a/b" }, contentDetails: { duration: "PT5M21S" } };
  it("returns meta and never puts the key anywhere but the query string", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ items: [item] }), { status: 200 }));
    const meta = await fetchYouTubeMeta("C-RdbraCrew", "KEY", fetchFn as never);
    expect(meta).toEqual({ title: "T", channel: "C", publishedAt: "2026-09-20T00:00:00Z", durationSec: 321, description: "D https://github.com/a/b" });
    const url = String(fetchFn.mock.calls[0][0]);
    expect(url).toContain("id=C-RdbraCrew");
    expect(url).toContain("part=snippet%2CcontentDetails");
  });
  it("returns null without a key, on HTTP error, on empty items, or on throw", async () => {
    expect(await fetchYouTubeMeta("x", undefined, vi.fn() as never)).toBeNull();
    expect(await fetchYouTubeMeta("x", "K", (async () => new Response("no", { status: 403 })) as never)).toBeNull();
    expect(await fetchYouTubeMeta("x", "K", (async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as never)).toBeNull();
    expect(await fetchYouTubeMeta("x", "K", (async () => { throw new Error("net"); }) as never)).toBeNull();
  });
});
```

- [ ] **Step 4: 跑测试确认失败**：`npx vitest run lib/config.test.ts lib/analysis/material/youtube.test.ts` → FAIL。

- [ ] **Step 5: 实现 `youtube.ts`**

```ts
import { z } from "zod";

export interface YouTubeMeta { title: string; channel: string; publishedAt: string; durationSec: number | null; description: string }

const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com", "youtube-nocookie.com"]);

/** The 11-char video id of an https YouTube link (watch / youtu.be / shorts / live / embed), or null. */
export function parseYouTubeUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const candidate = url.hostname === "youtu.be" ? segments[0]
    : segments[0] === "watch" ? url.searchParams.get("v")
    : ["shorts", "live", "embed"].includes(segments[0] ?? "") ? segments[1]
    : null;
  return candidate && ID.test(candidate) ? candidate : null;
}

/** Seconds in an ISO 8601 duration such as "PT1H2M3S" / "P1DT1S"; null when unparseable. */
export function parseIsoDuration(iso: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m || iso === "P" || iso === "PT") return null;
  const [d, h, min, s] = m.slice(1).map((v) => Number(v ?? 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

const responseSchema = z.object({
  items: z.array(z.object({
    snippet: z.object({ title: z.string(), channelTitle: z.string(), publishedAt: z.string(), description: z.string().default("") }),
    contentDetails: z.object({ duration: z.string() }).partial().default({})
  }))
});

const TIMEOUT_MS = 10_000;

/**
 * Public metadata for one video via YouTube Data API v3 (`videos.list`). Every failure -- no key,
 * network, HTTP error, unexpected shape, no such video -- resolves to null: metadata only enriches
 * the analysis, it must never fail it. The key only ever travels in the query string.
 */
export async function fetchYouTubeMeta(videoId: string, apiKey: string | undefined, fetchFn: typeof fetch = globalThis.fetch, signal?: AbortSignal): Promise<YouTubeMeta | null> {
  if (!apiKey) return null;
  const params = new URLSearchParams({ part: "snippet,contentDetails", id: videoId, key: apiKey });
  try {
    const response = await fetchFn(`https://www.googleapis.com/youtube/v3/videos?${params}`, { signal: signal ?? AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    const parsed = responseSchema.safeParse(await response.json());
    const item = parsed.success ? parsed.data.items[0] : undefined;
    if (!item) return null;
    return {
      title: item.snippet.title, channel: item.snippet.channelTitle, publishedAt: item.snippet.publishedAt,
      durationSec: item.contentDetails.duration ? parseIsoDuration(item.contentDetails.duration) : null,
      description: item.snippet.description
    };
  } catch {
    return null;
  }
}
```

（`URLSearchParams` 会把逗号编码成 `%2C`，与测试一致。）

- [ ] **Step 6: `material/index.ts`**：`Material` 联合类型加 video；`import { parseYouTubeUrl, type YouTubeMeta } from "./youtube"`；`case "url"` 改为：

```ts
    case "url": {
      const videoId = parseYouTubeUrl(capture.url!);
      if (videoId) return { kind: "video", platform: "youtube", url: `https://www.youtube.com/watch?v=${videoId}`, videoId, meta: null };
      return { kind: "url", url: capture.url!, text: await fetchUrlText(capture.url!, deps.fetch) };
    }
```

并导出 `YouTubeMeta` 类型。给 `material` 已有测试（若有 index 测试）加一条：YouTube 链接返回 video 且未调用 fetch。

- [ ] **Step 7:** `npm run typecheck` —— `Material` 新成员会让所有按 kind 分支的地方报「未处理」或类型不收窄：**只在本任务里修到能编译**（prompts.ts 的 `materialText` / `searchQuery`、prompt-locate、pipeline 的 similarSeed 等给 video 一个最小占位分支，例如 `material.kind === "video" ? material.url`），正式逻辑在 Task 3 / 4 写。然后 `npm test` 全绿。

- [ ] **Step 8: Commit** `feat(caphub): recognise YouTube links and fetch video metadata`

---

### Task 2: Gemini 看视频 provider

**Files:** Modify `lib/analysis/structured.ts`; Create `lib/providers/gemini-video.ts`, `lib/providers/gemini-video.test.ts`.

**Interfaces — Produces:**
- `StructuredInput.video?: { url: string; endOffsetSec?: number }`；`RunStructuredRequest.video?` 同型，`runStructured` 透传给 `call.invoke`。
- `export function createGeminiVideoCall(opts: { apiKey: string; model: string; fetch?: typeof fetch }): StructuredCall`（`provider: "gemini"`）。

- [ ] **Step 1: 测试**

```ts
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ProviderError } from "./errors";
import { createGeminiVideoCall } from "./gemini-video";

const schema = z.object({ what: z.string() });
const ok = (text: string) => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: 30000, candidatesTokenCount: 200, thoughtsTokenCount: 50 }
}), { status: 200 });

describe("createGeminiVideoCall", () => {
  it("sends the YouTube URL as fileData with the prompt, and maps usage", async () => {
    const fetchFn = vi.fn(async () => ok('{"what":"w"}'));
    const call = createGeminiVideoCall({ apiKey: "K", model: "gemini-3.8-flash", fetch: fetchFn as never });
    const out = await call.invoke({ prompt: "p", schemaName: "x", schema, video: { url: "https://www.youtube.com/watch?v=tYvu6IpSfiM" } }, new AbortController().signal);
    expect(out).toEqual({ value: { what: "w" }, usage: { inputTokens: 30000, outputTokens: 250 } });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("K");
    const body = JSON.parse(String(init.body));
    expect(body.contents[0].parts[0]).toEqual({ fileData: { fileUri: "https://www.youtube.com/watch?v=tYvu6IpSfiM" } });
    expect(body.contents[0].parts[1].text).toContain("p");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(call.provider).toBe("gemini");
    expect(call.model).toBe("gemini-3.8-flash");
  });

  it("adds videoMetadata.endOffset when clipping", async () => {
    const fetchFn = vi.fn(async () => ok('{"what":"w"}'));
    const call = createGeminiVideoCall({ apiKey: "K", model: "m", fetch: fetchFn as never });
    await call.invoke({ prompt: "p", schemaName: "x", schema, video: { url: "u", endOffsetSec: 5400 } }, new AbortController().signal);
    const body = JSON.parse(String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.contents[0].parts[0].videoMetadata).toEqual({ endOffset: "5400s" });
  });

  it("rejects a call without a video", async () => {
    const call = createGeminiVideoCall({ apiKey: "K", model: "m", fetch: vi.fn() as never });
    await expect(call.invoke({ prompt: "p", schemaName: "x", schema }, new AbortController().signal)).rejects.toThrow();
  });

  it("maps HTTP errors without leaking the key", async () => {
    const call = createGeminiVideoCall({ apiKey: "SECRET", model: "m", fetch: (async () => new Response('{"error":{"message":"Video unavailable"}}', { status: 400 })) as never });
    const err = await call.invoke({ prompt: "p", schemaName: "x", schema, video: { url: "u" } }, new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("INVALID_OUTPUT");
    expect((err as ProviderError).detail).toContain("400");
    expect((err as ProviderError).detail).not.toContain("SECRET");
  });

  it("raises INVALID_OUTPUT with raw text and usage for non-JSON text", async () => {
    const call = createGeminiVideoCall({ apiKey: "K", model: "m", fetch: (async () => ok("not json")) as never });
    const err = await call.invoke({ prompt: "p", schemaName: "x", schema, video: { url: "u" } }, new AbortController().signal).catch((e) => e) as ProviderError;
    expect(err.code).toBe("INVALID_OUTPUT");
    expect(err.raw).toBe("not json");
    expect(err.usage).toEqual({ inputTokens: 30000, outputTokens: 250 });
  });

  it("maps network failure to UNAVAILABLE and abort to ABORTED", async () => {
    const net = createGeminiVideoCall({ apiKey: "K", model: "m", fetch: (async () => { throw new Error("x"); }) as never });
    await expect(net.invoke({ prompt: "p", schemaName: "x", schema, video: { url: "u" } }, new AbortController().signal)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const c = new AbortController(); c.abort();
    const ab = createGeminiVideoCall({ apiKey: "K", model: "m", fetch: (async () => { throw new Error("aborted"); }) as never });
    await expect(ab.invoke({ prompt: "p", schemaName: "x", schema, video: { url: "u" } }, c.signal)).rejects.toMatchObject({ code: "ABORTED" });
  });
});
```

另在 `lib/analysis/structured.test.ts`（若存在）加一条：`runStructured({ ..., video: { url: "u" } })` 时 `call.invoke` 收到的 input 含 `video`。

- [ ] **Step 2: 确认失败**：`npx vitest run lib/providers/gemini-video.test.ts` → FAIL。

- [ ] **Step 3: 实现**

`structured.ts`：`StructuredInput` 加 `video?: { url: string; endOffsetSec?: number };`，`RunStructuredRequest` 加 `video?: StructuredInput["video"];`，`invoke` 调用处加 `video: req.video,`。

`gemini-video.ts`：

```ts
import type { StructuredCall, StructuredInput } from "../analysis/structured";
import { ProviderError, failureForHttpStatus } from "./errors";
import { buildStructuredPrompt, parseJsonObject } from "./prompt";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

/**
 * Gemini watching a YouTube video by URL (spike: docs/spike-video.md). Google fetches the video
 * itself -- Caphub never downloads it -- so this only works for public videos. The key goes in
 * a header and is never echoed into errors.
 */
export function createGeminiVideoCall(opts: { apiKey: string; model: string; fetch?: typeof fetch }): StructuredCall {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  return {
    provider: "gemini",
    model: opts.model,
    async invoke(input: StructuredInput, signal: AbortSignal) {
      if (!input.video) throw new ProviderError("INVALID_OUTPUT", { detail: "gemini video call requires input.video" });
      const videoPart: Record<string, unknown> = { fileData: { fileUri: input.video.url } };
      if (input.video.endOffsetSec !== undefined) videoPart.videoMetadata = { endOffset: `${input.video.endOffsetSec}s` };
      let response: Response;
      try {
        response = await fetchFn(`${GEMINI_BASE_URL}/models/${opts.model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": opts.apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [videoPart, { text: buildStructuredPrompt(input) }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
          }),
          signal
        });
      } catch (error) {
        throw new ProviderError(signal.aborted ? "ABORTED" : "UNAVAILABLE", { cause: error });
      }
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new ProviderError(failureForHttpStatus(response.status), { detail: `HTTP ${response.status}: ${bodyText.slice(0, 500)}` });
      }
      let payload: GenerateContentResponse;
      try { payload = await response.json() as GenerateContentResponse; } catch (error) { throw new ProviderError("INVALID_OUTPUT", { cause: error }); }
      const text = (payload.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      const meta = payload.usageMetadata;
      if (!text.trim() || typeof meta?.promptTokenCount !== "number") throw new ProviderError("INVALID_OUTPUT", { detail: "empty candidate or missing usage" });
      const usage = { inputTokens: meta.promptTokenCount, outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0) };
      let value: unknown;
      try { value = parseJsonObject(text); } catch (error) {
        throw new ProviderError("INVALID_OUTPUT", { cause: error, raw: text.slice(0, 20_000), usage });
      }
      return { value, usage };
    }
  };
}
```

（先读 `lib/providers/prompt.ts` 确认 `buildStructuredPrompt` / `parseJsonObject` 的签名与行为；`parseJsonObject("not json")` 必须抛。）

- [ ] **Step 4:** `npx vitest run lib/providers lib/analysis/structured.test.ts && npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(caphub): Gemini video call reading YouTube links by URL`

---

### Task 3: 视频抽取 schema 与提示词

**Files:** Modify `lib/analysis/card.ts` (+test), `lib/analysis/prompts.ts` (+test), `lib/analysis/prompt-locate.ts` (+test).

**Interfaces — Consumes:** `Material` video 类型（Task 1）。**Produces:**
- `export const videoExtractionSchema`（= `extractionSchema.extend({ key_moments })`），`export type VideoExtraction`。
- `export const VIDEO_CLIP_SEC = 5400`（放在 `lib/analysis/card.ts`）。
- `export function videoPrompt(meta: YouTubeMeta | null, clipped: boolean): string`
- `reasonPrompt` 新增入参 `videoFailed?: boolean`（仅视频用）；`searchQuery` / `collectPrompts` 视频分支。

- [ ] **Step 1: 测试**

card.test.ts：
```ts
describe("videoExtractionSchema", () => {
  const base = { what: "w", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [] };
  it("accepts key moments with mm:ss or h:mm:ss and defaults to []", () => {
    expect(videoExtractionSchema.parse(base).key_moments).toEqual([]);
    expect(videoExtractionSchema.parse({ ...base, key_moments: [{ t: "01:57", note: "n" }, { t: "1:02:03", note: "m" }] }).key_moments).toHaveLength(2);
    expect(() => videoExtractionSchema.parse({ ...base, key_moments: [{ t: "1m", note: "n" }] })).toThrow();
  });
});
```

prompts.test.ts：
```ts
describe("video prompts", () => {
  const meta = { title: "Jev 实测", channel: "01Coder", publishedAt: "2026-09-20T00:00:00Z", durationSec: 1015, description: "repo https://github.com/typesafe-ai/skills" };
  const video = { kind: "video", platform: "youtube", url: "https://www.youtube.com/watch?v=tYvu6IpSfiM", videoId: "tYvu6IpSfiM", meta } as const;
  const common = { sources: [], similar: [], existingTags: [], scenarios: [{ slug: "coding", labelZh: "编程", labelEn: "Coding", keywords: [] }] };

  it("videoPrompt carries metadata, asks for verbatim prompts and key moments, notes clipping", () => {
    const p = videoPrompt(meta, false);
    expect(p).toContain("Jev 实测");
    expect(p).toContain("https://github.com/typesafe-ai/skills");
    expect(p).toContain("逐字");
    expect(p).toContain("key_moments");
    expect(p).not.toContain("前 90 分钟");
    expect(videoPrompt(meta, true)).toContain("前 90 分钟");
    expect(videoPrompt(null, false)).toContain("无元数据");
  });

  it("reasonPrompt shows video metadata + extraction, and the failure/clip notes", () => {
    const ok = reasonPrompt({ ...common, material: video, extraction: { what: "w", visible_text: "", commands: [], prompts: [], source_hints: [], questions: [] } } as never);
    expect(ok).toContain("YouTube 视频");
    expect(ok).toContain("Jev 实测");
    expect(ok).toContain("视频内容提取结果");
    expect(ok).toContain("prompt_locators 给空数组");
    const failed = reasonPrompt({ ...common, material: video, extraction: null, videoFailed: true } as never);
    expect(failed).toContain("视频内容未能读取");
    const long = reasonPrompt({ ...common, material: { ...video, meta: { ...meta, durationSec: 7200 } }, extraction: null } as never);
    expect(long).toContain("只分析了前 90 分钟");
  });

  it("searchQuery falls back to the video title without an extraction", () => {
    expect(searchQuery(null, video as never)).toBe("Jev 实测");
    expect(searchQuery(null, { ...video, meta: null } as never)).toBe(video.url);
  });
});
```
（`Scenario` 字段名先 `grep -n "export interface Scenario" -A6 lib/analysis/scenarios.ts` 核对。）

prompt-locate.test.ts：
```ts
it("uses the video transcription for a video, like an image", () => {
  const video = { kind: "video", platform: "youtube", url: "u", videoId: "tYvu6IpSfiM", meta: null } as const;
  const extraction = { what: "w", visible_text: "", commands: [], prompts: ["口述的 prompt"], source_hints: [], questions: [] };
  expect(collectPrompts({ material: video, extraction, locators: [{ start: "x", end: "y" }] })).toEqual({ prompts: ["口述的 prompt"], unresolved: 0 });
  expect(collectPrompts({ material: video, extraction: null, locators: [] })).toEqual({ prompts: [], unresolved: 0 });
});
```

- [ ] **Step 2: 确认失败。**

- [ ] **Step 3: 实现**

card.ts：
```ts
/** Video transcription (lib/providers/gemini-video.ts): the image extraction plus timestamped key moments. */
export const videoExtractionSchema = extractionSchema.extend({
  key_moments: z.array(z.object({
    t: z.string().regex(/^\d{1,2}:\d{2}(?::\d{2})?$/),
    note: z.string().min(1).max(120)
  })).max(8).default([])
});
export type VideoExtraction = z.infer<typeof videoExtractionSchema>;
export const VIDEO_CLIP_SEC = 5400;
```

prompts.ts — `videoPrompt`：
```ts
function formatDuration(sec: number | null): string {
  if (sec === null) return "未知";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function videoMetaText(meta: YouTubeMeta | null): string {
  return meta
    ? `标题：${meta.title}\n频道：${meta.channel}\n发布：${meta.publishedAt}\n时长：${formatDuration(meta.durationSec)}\n简介：\n${meta.description.slice(0, 4000)}`
    : "（无元数据）";
}

export function videoPrompt(meta: YouTubeMeta | null, clipped: boolean): string {
  return [
    "你在整理一个个人 agent 能力库。请看这个 YouTube 视频（画面 + 语音），提取其中关于「能力」（skill、工具、plugin、prompt、模型、经验做法）的信息。",
    "要求：what 用一两句话说明视频展示/讲解的是什么能力；visible_text 抄录画面中出现的关键文字（仓库名、网址、命令、界面文字）；commands 列出画面或语音中出现的安装/运行命令；prompts 列出视频中完整出现（画面展示或口述）的每一条提示词原文，每条单独一项、逐字抄录，不翻译、不润色、不补全、不合并，最多 20 条、按出现顺序，没有就给空数组；source_hints 列出作者、仓库、网址、产品名（简介里的链接也算）；questions 列出看完仍无法确定、需要联网核实的问题（最多 5 条）；key_moments 给 3–8 个关键片段，t 为 mm:ss（超过 1 小时用 h:mm:ss），note 一句话说明该片段的内容。",
    clipped ? "注意：视频超过 90 分钟，这里只提供了前 90 分钟的内容。" : "",
    `视频元数据（来自 YouTube Data API）：\n${videoMetaText(meta)}`
  ].filter(Boolean).join("\n\n");
}
```

`reasonPrompt`：入参加 `videoFailed?: boolean`；`materialText` 增加视频分支：
```ts
    : input.material.kind === "video"
      ? `YouTube 视频：${input.material.url}\n${videoMetaText(input.material.meta)}`
```
（放在 image 分支之前）；把 `input.extraction ? \`视觉提取结果：...\`` 改为按素材类型：视频有 extraction 时标题用「视频内容提取结果」，视频无 extraction 时写「视频内容未能读取：只能依据标题与简介判断，必须在 signals 里写一条「视频未能读取，仅依据标题与简介」」；视频且 `meta?.durationSec` 大于 `VIDEO_CLIP_SEC` 时追加「视频超过 90 分钟，只分析了前 90 分钟，必须在 signals 里写明这一点」。`prompt_locators` 的图片分支条件改为 `kind === "image" || kind === "video"`，视频分支文字写「prompt_locators 给空数组：视频里的提示词原文已由视频提取单独保存。」（测试断言包含「prompt_locators 给空数组」）。

`searchQuery`：`if (material.kind === "video") return (material.meta?.title ?? material.url).slice(0, 400);` 放在 extraction 分支之后。

`collectPrompts`：条件 `material.kind === "image"` 改为 `material.kind === "image" || material.kind === "video"`（extraction 为 null 时返回空、unresolved 0——现有逻辑已如此，确认即可）。

Task 1 留下的占位分支在这里换成正式逻辑。

- [ ] **Step 4:** `npm run typecheck && npx vitest run lib/analysis` → PASS。
- [ ] **Step 5: Commit** `feat(caphub): video extraction schema and prompts`

---

### Task 4: Pipeline 接线

**Files:** Modify `lib/analysis/pipeline.ts`, `lib/analysis/pipeline.test.ts`, `lib/analysis/material/index.ts`（`MaterialDeps.youtubeApiKey`）。

**Interfaces — Consumes:** Task 1–3 全部。**Produces:**
- `TIMEOUTS.video = 300_000`；`export const VIDEO_BUDGET = { maxCalls: 4, maxTokens: 600_000 }`。
- `PipelineDeps.video?: StructuredCall`；`MaterialDeps.youtubeApiKey?: string`。
- `createPipelineDeps`：所有模式下 `video: geminiApiKey ? createGeminiVideoCall({ apiKey: geminiApiKey, model: config.geminiVideoModel }) : undefined`，`material: { youtubeApiKey: config.providers.youtubeApiKey }`。

流程（`runPipeline` 内，`prepareMaterial` 之后）：

```ts
  let material = await prepareMaterial(...);
  const budget = new RunBudget(material.kind === "video" ? VIDEO_BUDGET : undefined);
  let extraction: Extraction | null = null;
  let videoFailed = false;
  if (material.kind === "video") {
    const started = Date.now();
    const meta = await fetchYouTubeMeta(material.videoId, deps.material.youtubeApiKey, deps.material.fetch, signal);
    await recordStep(deps.pool, { runId: lease.runId, step: "fetch", provider: "youtube", model: "data-api-v3", attempt: 1, durationMs: Date.now() - started, ok: meta !== null, output: meta });
    material = { ...material, meta };
    const clipped = (meta?.durationSec ?? 0) > VIDEO_CLIP_SEC;
    if (!deps.video) {
      videoFailed = true;
    } else {
      try {
        extraction = await runStructured({
          pool: deps.pool, runId: lease.runId, step: "vision", call: deps.video,
          prompt: videoPrompt(meta, clipped), video: { url: material.url, ...(clipped ? { endOffsetSec: VIDEO_CLIP_SEC } : {}) },
          schemaName: "video_extraction", schema: videoExtractionSchema, budget, timeoutMs: TIMEOUTS.video, signal
        });
      } catch (error) {
        // Budget exhaustion and cancellation must still end the run; anything else (private /
        // removed video, Gemini outage) falls back to a metadata-only analysis sent to Review.
        if (error instanceof ProviderError && (error.code === "BUDGET" || error.code === "ABORTED")) throw error;
        videoFailed = true;
      }
    }
  } else if (material.kind === "image") { ...现有 vision... }
```

- `reasonPrompt({ ..., videoFailed })`；
- 相似度种子：`extraction?.what ?? (material.kind === "text" ? material.text : material.kind === "url" ? material.text ?? material.url : material.kind === "video" ? material.meta?.title ?? material.url : "")`；
- 裁决：`const decision = videoFailed ? { verdict: "pending" as const, by: null } : decideVerdict(...)`。
- 没有 `deps.video` 时不记 vision 步骤（fetch 步骤照记）。
- `fetchYouTubeMeta` 需要 `signal` 参数（Task 1 已含）。

- [ ] **Step 1: 测试（`pipeline.test.ts`）**

`deps()` 扩展：`kind` 允许 `"video"`（capture 行 `kind: "url"`, `url: "https://youtu.be/tYvu6IpSfiM"`）；选项 `videoValue?`、`videoThrows?: string`（ProviderError code）、`noVideo?: boolean`、`meta?: object | null`（`material.fetch` 注入的 YouTube API fake：返回 `{ items: [...] }` 或 404）、`durationIso?: string`。`d.video` 为记录调用的 fake StructuredCall（push `"video"`，记录收到的 input）。

用例：
1. 正常：调用顺序 `["video", "search", "embed", "reason"]`；记了一条 `fetch` 步骤（provider youtube、ok true）；视频 input 的 `url` 为 `https://www.youtube.com/watch?v=tYvu6IpSfiM`，无 `endOffsetSec`；reason 提示词含「视频内容提取结果」与元数据标题；裁决按置信度（keep）。
2. 预算：视频 fake 返回 usage `{ inputTokens: 450_000, outputTokens: 1000 }` 仍能跑完 reason（证明用了 600k 预算）。
3. 超 90 分钟：`durationIso: "PT2H"` → 视频 input 含 `endOffsetSec: 5400`，reason 提示词含「只分析了前 90 分钟」。
4. 视频失败：`videoThrows: "INVALID_OUTPUT"`（fake 抛 `new ProviderError("INVALID_OUTPUT")`；注意 runStructured 会原样上抛 ProviderError）→ run 不失败，reason 提示词含「视频内容未能读取」，`out.verdict === "pending"`。
5. `videoThrows: "BUDGET"` → run 抛错。
6. `noVideo: true` → 无 vision 调用，仍有 fetch 步骤，裁决 pending。
7. 元数据失败（fake 返回 404）→ fetch 步骤 ok false，视频仍被调用，提示词含「无元数据」。
8. prompts：视频 extraction `prompts: ["口述 prompt"]` → upsert 参数 `$24` 为 `JSON.stringify([{ text: "口述 prompt" }])`。
9. 非 YouTube 的 url 投递行为不变（已有用例继续通过）。

- [ ] **Step 2: 确认失败 → Step 3: 实现 → Step 4:** `npm run typecheck && npm test` 全绿。
- [ ] **Step 5: Commit** `feat(caphub): analyse YouTube videos with Gemini, falling back to metadata`

---

### Task 5: 详情数据

**Files:** Modify `lib/library/queries.ts`（及其测试，若无则在 `lib/library/queries.test.ts` 新增针对纯函数的测试）。

**Interfaces — Produces:**
- `export interface VideoDetail { videoId: string; title: string | null; channel: string | null; durationSec: number | null; clipped: boolean; failed: boolean; moments: Array<{ t: string; note: string }> }`
- `CapabilityDetail.video: VideoDetail | null`
- `export function buildVideoDetail(captureUrl: string | null, steps: Array<{ step: string; provider: string; ok: boolean; output: unknown }>): VideoDetail | null`（纯函数，便于测试）

实现：`getCapabilityDetail` 的步骤查询把 `output` 的 CASE 扩为 `WHEN (step = 'search' AND ok) OR (step = 'fetch' AND provider = 'youtube') OR (step = 'vision' AND provider = 'gemini') THEN output`；`video = buildVideoDetail(row.capture.url, steps)`：
- `parseYouTubeUrl(captureUrl)` 为 null → 返回 null；
- meta = 最后一条 `fetch`/`youtube` 且 ok 的 output；
- 视频抽取 = 最后一条 `vision`/`gemini` 且 ok 的 output；`failed = !抽取`；
- `clipped = (meta?.durationSec ?? 0) > VIDEO_CLIP_SEC`；`moments = 抽取?.key_moments ?? []`（用 `videoExtractionSchema.shape.key_moments.safeParse` 防御旧/坏数据，失败则 `[]`）。

测试：非 YouTube 返回 null；正常；失败（无 ok 的 gemini vision）；clipped；坏 key_moments 返回 []。

- [ ] 步骤同上（测试 → 失败 → 实现 → `npm run typecheck && npm test` → commit `feat(caphub): assemble video details for the capability page`）。

---

### Task 6: 展示

**Files:** Create `components/capability/video-summary.tsx` (+test)；Modify `components/capability/capture-preview.tsx`、两个详情页、`lib/i18n/dict-zh.ts`、`dict-en.ts`、`app/globals.css`。

先读 `node_modules/next/dist/docs/` 里 Server / Client Components 相关指南。`VideoSummary` 是服务端组件（无交互）。

**Interfaces — Consumes:** `CapabilityDetail.video`（Task 5）、`parseYouTubeUrl`。**Produces:** `VideoSummary({ video, locale })`、`momentSeconds(t: string): number | null`。

文案（`detail` 下）：
- zh：`video: "视频"`、`videoMeta: "{channel} · {duration}"`、`videoClipped: "视频超过 90 分钟，只分析了前 90 分钟"`、`videoFailed: "视频未能读取，仅依据标题与简介"`、`videoMoments: "关键片段"`
- en：`video: "Video"`、`videoMeta: "{channel} · {duration}"`、`videoClipped: "Longer than 90 minutes — only the first 90 were analysed"`、`videoFailed: "The video could not be read; based on title and description only"`、`videoMoments: "Key moments"`

组件：
```tsx
export function momentSeconds(t: string): number | null {
  const parts = t.split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function VideoSummary({ video, locale = "zh" }: { video: VideoDetail | null; locale?: Locale }) {
  if (!video) return null;
  const dict = getDict(locale).detail;
  const watch = (sec?: number) => `https://www.youtube.com/watch?v=${video.videoId}${sec ? `&t=${sec}s` : ""}`;
  return (
    <section className="panel">
      <h2 className="panel-title">{dict.video}</h2>
      <p className="video-summary__title"><a href={watch()} target="_blank" rel="noreferrer">{video.title ?? watch()}</a></p>
      {video.channel && <p className="video-summary__meta">{format(dict.videoMeta, { channel: video.channel, duration: formatDuration(video.durationSec) })}</p>}
      {video.clipped && <p className="prompt-notice">{dict.videoClipped}</p>}
      {video.failed && <p className="prompt-notice">{dict.videoFailed}</p>}
      {video.moments.length > 0 && (
        <>
          <h3 className="video-summary__subtitle">{dict.videoMoments}</h3>
          <ul className="video-moments">
            {video.moments.map((m, i) => {
              const sec = momentSeconds(m.t);
              return <li key={i}>{sec === null ? <span className="video-moments__t">{m.t}</span> : <a className="video-moments__t" href={watch(sec)} target="_blank" rel="noreferrer">{m.t}</a>} {m.note}</li>;
            })}
          </ul>
        </>
      )}
    </section>
  );
}
```
（`formatDuration` 与 prompts.ts 的同名逻辑一致：抽到 `lib/text/duration.ts` 共用，prompts.ts 改为从那里导入；`durationSec` 为 null 时显示「未知」/「unknown」——为此 `videoMeta` 中 duration 由组件按 locale 传入。）

`CapturePreview`：`kind === "url"` 时若 `parseYouTubeUrl(capture.url)` 命中：thumb 尺寸渲染 `<img className="thumb" src={\`https://i.ytimg.com/vi/${id}/hqdefault.jpg\`} alt={dict.linkThumb} loading="lazy" referrerPolicy="no-referrer" />`，full 尺寸渲染缩略图 + 原链接。（`capture-preview.tsx` 是 client 组件，只加渲染分支，不新增服务端调用。）

两个详情页：在「一句话总结」面板之后插入 `<VideoSummary video={detail.video} locale={locale} />`。

样式（globals.css）：`.video-summary__meta`、`.video-summary__subtitle`、`.video-moments`（列表、时间点等宽字体、链接色），照现有 panel 风格。

测试：`VideoSummary` null 不渲染；正常渲染标题链接、频道 · 时长、关键片段链接 `&t=117s`（`01:57`）；clipped / failed 提示；非法时间点不渲染链接；`momentSeconds` 用例（`"01:57"`→117、`"1:02:03"`→3723、`"x"`→null）；`CapturePreview` 对 YouTube 链接渲染 i.ytimg 缩略图、对普通链接不变。

- [ ] 测试 → 失败 → 实现 → `npm run typecheck && npm run lint && npm test` → commit `feat(caphub): show video summary and key moments on the capability page`。

---

### Task 7: 全量检查 + 最终评审

- [ ] `npm run typecheck && npm run lint && npm test && npm run build`。
- [ ] 最终整分支评审（最强模型），修复后再跑一遍。

### Task 8: 真实预演（controller 执行）→ 停在上线前

- [ ] 从生产建临时 Neon branch；本地 worker 指向它：`railway run -s worker -- env DATABASE_URL=<临时 branch 连接串> TELEGRAM_ENABLED=false RETENTION_ENABLED=false npx tsx scripts/worker.ts`（**必须关掉 Telegram 与 retention**：前者会与线上 worker 抢同一个 bot 的更新，后者会按临时库的记录删除共享 S3 桶里的对象）。
- [ ] 在临时 branch 上对 Joey 的 5 个视频 capture 各排一次重跑（`requestRerun`），等待完成；核对：fetch / vision / search / reason 步骤、token、耗时、卡片内容、prompts、裁决。
- [ ] 本地 `localhost` web + Mini 详情页截图（1440 / 390），检查视频摘要、关键片段链接、缩略图、无横向溢出。
- [ ] 结果追加到 `docs/spike-video.md`「上线前预演」一节。
- [ ] **停下**：向 Joey 报告，确认后再合并推送（无迁移），并重跑生产上这 5 条（真实模型调用）。
