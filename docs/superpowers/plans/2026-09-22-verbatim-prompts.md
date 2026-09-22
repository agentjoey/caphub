# Prompt 原文独立保存与展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 所有能力的 prompt 原文从输入源逐字摘取、存进独立列 `prompts`、在详情页单独展示；模型永远不写这一列。

**Architecture:** 截图走视觉逐字抄录（`extraction.prompts`）；文字 / 网页由 reason 只给每条 prompt 的首尾锚点（`prompt_locators`），纯函数 `collectPrompts` 在同一份原文里截取整段。结果与卡片同事务写入 `capabilities.prompts` / `prompt_unresolved`；enrich、deep 不碰这两列。`decideVerdict` 对缺原文或定位失败的卡强制进 Review。存量卡用不调模型的回填脚本从历史 vision 步骤输出补齐。

**Tech Stack:** Next.js 16.3.3 App Router · React 19 · pg · Zod 4 · Vitest · Neon Postgres（schema `caphub_v2`）

**Spec:** `docs/superpowers/specs/2026-09-22-verbatim-prompts-design.md`

## Global Constraints

- 原文只来自输入源（截图 / `captures.text` / 抓取的网页正文），联网搜索结果永远不算。
- 存下来的原文不得截断、改写、翻译、合并；超过单条上限的条目丢弃并计入 `prompt_unresolved`，不截断。
- 单条原文 ≤ 20,000 字，最多 20 条。
- `prompts` 列元素形状：`{ "text": string }`。
- 测试不连真实数据库 / 模型；真实验证用临时 Neon branch，用完删除；本地浏览器验证用 `localhost`。
- 先迁移再推送（部署不跑迁移）；生产库迁移与回填需 Joey 单独授权。
- 密钥只在 Railway 变量；不打印、不入库。
- 读 `node_modules/next/dist/docs/` 里相关指南后再写 Next.js 代码（AGENTS.md）。
- 命令：`npm test`（vitest run）、`npm run typecheck`、`npm run lint`、`npx vitest run <path>`。

## 相对 spec 的一处简化

spec §2「网页抓取」写的是「新增保留换行的正文，现有压平版本保留给搜索词等用途」。实查后 `fetchUrlText` 只有 `prepareMaterial` 一个调用方，而网页素材的搜索词用的是 `material.url`、相似度种子对换行不敏感，没有地方需要压平版本。所以本计划**直接把 `fetchUrlText` 改成保留换行**，不另起第二个版本；`stripHtml` 本身不动（`canonical.ts` 仍在用）。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `lib/db/migrations/014_verbatim_prompts.sql` | 新建 | `prompts`、`prompt_unresolved` 两列；全文检索纳入 `prompts` |
| `lib/analysis/prompt-locate.ts` | 新建 | 纯函数：锚点定位 `locatePrompts`、按素材汇总 `collectPrompts` |
| `lib/analysis/card.ts` | 改 | `extraction.prompts`、`card.prompt_locators`、`integrate` playbook 去掉 `prompt_text`、`MAX_PROMPTS`/`MAX_PROMPT_CHARS` |
| `lib/analysis/prompts.ts` | 改 | vision / reason / enrich 提示词措辞 |
| `lib/analysis/material/url.ts` | 改 | `htmlToText` 保留换行；抓取上限 100 KB |
| `lib/analysis/verdict.ts` | 改 | 原文规则 |
| `lib/analysis/capabilities.ts` | 改 | upsert 写两列 |
| `lib/analysis/pipeline.ts` | 改 | 接线 `collectPrompts` → `decideVerdict` → upsert |
| `lib/library/queries.ts` | 改 | `CapabilityRow.prompts` / `promptUnresolved` |
| `lib/mcp/tools.ts` | 改 | `get_capability` 输出 `prompts` |
| `components/capability/source-prompts.tsx` | 新建 | 「Prompt 原文」面板 |
| `components/capability/prompt-notice.tsx` | 新建 | Review 提示（未定位 / 未摘到） |
| `components/capability/playbook-view.tsx` | 改 | 删 prompt 块；导出 `playbookHasContent` |
| `components/capability/card-summary.tsx` | 改 | 挂 `PromptNotice`（web / mini Review 共用） |
| `app/(chrome)/library/[id]/page.tsx`、`app/mini/library/[id]/page.tsx` | 改 | 插入面板；空「怎么用」不渲染 |
| `lib/i18n/dict-zh.ts`、`lib/i18n/dict-en.ts` | 改 | 新文案 |
| `lib/seed/demo.ts` | 改 | 示例卡的 prompt 挪到 `prompts` |
| `scripts/backfill-prompts.ts` + test | 新建 | 存量回填 |

---

### Task 1: 迁移 014

**Files:**
- Create: `lib/db/migrations/014_verbatim_prompts.sql`
- Test: `lib/db/migrate.test.ts`（只在它已有「迁移文件按序号齐全」之类的断言时才需要改；先看再决定）

**Interfaces:**
- Produces: `caphub_v2.capabilities.prompts jsonb NOT NULL DEFAULT '[]'`、`caphub_v2.capabilities.prompt_unresolved smallint NOT NULL DEFAULT 0`；`caphub_v2.capability_search_text` 改为 7 个参数（末位 `prompts jsonb`）。

- [ ] **Step 1: 写迁移**

```sql
-- Prompt 原文独立保存（spec 2026-09-22-verbatim-prompts-design.md）。
-- prompts：[{ "text": string }]，只由代码从输入源摘取后写入，模型不写；
-- prompt_unresolved：本次分析里未能在原文中定位的条目数，供 Review 提示。
ALTER TABLE caphub_v2.capabilities
  ADD COLUMN prompts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN prompt_unresolved smallint NOT NULL DEFAULT 0;

-- 原文从 playbook 挪出来后仍要能被全文检索搜到。生成列表达式不能就地修改，
-- 只能 drop 后重建（连带重建 GIN 索引）——与 012、013 的做法一致。
ALTER TABLE caphub_v2.capabilities DROP COLUMN search;
DROP FUNCTION caphub_v2.capability_search_text(text, text, text[], jsonb, jsonb, jsonb);

-- 保持 IMMUTABLE：只对本函数自身参数做标准 SQL 强转与拼接，无目录查询，不依赖会话或 locale。
CREATE FUNCTION caphub_v2.capability_search_text(title text, summary text, tags text[], playbook jsonb, summary_points jsonb, build_notes jsonb, prompts jsonb) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(array_to_string(tags,' '),'') || ' ' || coalesce(playbook::text,'') || ' ' || coalesce(summary_points::text,'') || ' ' || coalesce(build_notes::text,'') || ' ' || coalesce(prompts::text,'') $$;

ALTER TABLE caphub_v2.capabilities ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('simple'::regconfig, caphub_v2.capability_search_text(title, summary, tags, playbook, summary_points, build_notes, prompts))
) STORED;
CREATE INDEX capabilities_search ON caphub_v2.capabilities USING gin(search);

-- 不需要 GRANT：caphub_v2_app 在 001 就有表级 SELECT/INSERT/UPDATE，新列继承表级授权。
```

- [ ] **Step 2: 检查迁移运行器约定**

Run: `sed -n 1,80p scripts/migrate.ts && sed -n 1,60p lib/db/migrate.test.ts`
确认文件名规则（`NNN_name.sql`）与测试是否枚举了迁移列表；若测试枚举，就把 `014_verbatim_prompts.sql` 加进去。

- [ ] **Step 3: 跑测试**

Run: `npx vitest run lib/db`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add lib/db/migrations/014_verbatim_prompts.sql lib/db/migrate.test.ts
git commit -m "feat(caphub): migration 014 — prompts and prompt_unresolved columns"
```

（真实迁移在 Task 10 于临时 Neon branch 上跑，此处不连库。）

---

### Task 2: 原文定位纯函数

**Files:**
- Create: `lib/analysis/prompt-locate.ts`
- Test: `lib/analysis/prompt-locate.test.ts`

**Interfaces:**
- Produces:
  - `export interface PromptLocator { start: string; end: string }`
  - `export function locatePrompts(source: string, locators: PromptLocator[]): { prompts: string[]; unresolved: number }`
  - `export function collectPrompts(input: { material: Material; extraction: Extraction | null; locators: PromptLocator[] }): { prompts: string[]; unresolved: number }`
  - `MAX_PROMPTS = 20`、`MAX_PROMPT_CHARS = 20_000` 从 `card.ts` 导入（Task 3 定义；本任务先在 `card.ts` 顶部加这两个常量，Task 3 再用）。

锚点匹配规则：先按原样精确查找；找不到时退回「空白不敏感」匹配（锚点里每段连续空白匹配原文里任意一段连续空白，其余字符逐字匹配）。两种方式截出来的都是**原文**那一段，存储值与原文逐字一致。`start` 从上一条的结束位置往后找，`end` 从 `start` 的起点往后找，截取 `[start 起点, max(end 终点, start 终点))`。

- [ ] **Step 1: 在 `lib/analysis/card.ts` 顶部（`capabilityTypeSchema` 之后）加常量**

```ts
/** Per-card cap on verbatim prompts, and per-prompt character cap (spec 2026-09-22). Over-cap items are dropped, never truncated. */
export const MAX_PROMPTS = 20;
export const MAX_PROMPT_CHARS = 20_000;
```

- [ ] **Step 2: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { collectPrompts, locatePrompts } from "./prompt-locate";

const SOURCE = [
  "今天分享两条提示词。",
  "第一条：",
  "你是一个信息整理助手。给定多篇来源文本，输出：",
  "1) 一句话标题；2) 3-5 条要点。不要编造。",
  "第二条：",
  "Act as a senior reviewer.  List risks first, then fixes.",
  "完。"
].join("\n");

describe("locatePrompts", () => {
  it("slices each prompt verbatim from the source, keeping line breaks", () => {
    const out = locatePrompts(SOURCE, [
      { start: "你是一个信息整理助手", end: "3-5 条要点。不要编造。" },
      { start: "Act as a senior", end: "then fixes." }
    ]);
    expect(out.unresolved).toBe(0);
    expect(out.prompts).toEqual([
      "你是一个信息整理助手。给定多篇来源文本，输出：\n1) 一句话标题；2) 3-5 条要点。不要编造。",
      "Act as a senior reviewer.  List risks first, then fixes."
    ]);
  });

  it("matches anchors whose whitespace the model normalised, but stores the source's own whitespace", () => {
    const out = locatePrompts(SOURCE, [{ start: "输出： 1) 一句话", end: "reviewer. List risks" }]);
    expect(out.prompts[0]).toContain("输出：\n1) 一句话");
    expect(out.prompts[0]).toContain("reviewer.  List risks");
  });

  it("counts an anchor that is not in the source as unresolved and drops it", () => {
    const out = locatePrompts(SOURCE, [{ start: "你是一个信息整理助手", end: "不存在的结尾" }, { start: "Act as", end: "fixes." }]);
    expect(out.unresolved).toBe(1);
    expect(out.prompts).toEqual(["Act as a senior reviewer.  List risks first, then fixes."]);
  });

  it("finds repeated anchors in order rather than reusing the first hit", () => {
    const src = "A: 请回答。\nB: 请回答。";
    const out = locatePrompts(src, [{ start: "请回答", end: "请回答。" }, { start: "请回答", end: "请回答。" }]);
    expect(out.prompts).toEqual(["请回答。", "请回答。"]);
    expect(out.unresolved).toBe(0);
  });

  it("handles a prompt shorter than its two anchors combined", () => {
    expect(locatePrompts("前言 做个按钮 后记", [{ start: "做个按钮", end: "做个按钮" }]).prompts).toEqual(["做个按钮"]);
  });

  it("drops (never truncates) a located prompt over MAX_PROMPT_CHARS", () => {
    const long = "开头" + "字".repeat(20_000) + "结尾";
    const out = locatePrompts(long, [{ start: "开头", end: "结尾" }]);
    expect(out.prompts).toEqual([]);
    expect(out.unresolved).toBe(1);
  });

  it("ignores locators beyond MAX_PROMPTS and counts them unresolved", () => {
    const src = Array.from({ length: 22 }, (_, i) => `P${i}x`).join(" ");
    const locators = Array.from({ length: 22 }, (_, i) => ({ start: `P${i}x`, end: `P${i}x` }));
    const out = locatePrompts(src, locators);
    expect(out.prompts).toHaveLength(20);
    expect(out.unresolved).toBe(2);
  });
});

describe("collectPrompts", () => {
  const extraction = { what: "w", visible_text: "", commands: [], prompts: ["图里的原文"], source_hints: [], questions: [] };

  it("uses the vision transcription for an image and ignores locators", () => {
    const out = collectPrompts({ material: { kind: "image", png: new Uint8Array(), ocrText: "", width: 1, height: 1 }, extraction, locators: [{ start: "x", end: "y" }] });
    expect(out).toEqual({ prompts: ["图里的原文"], unresolved: 0 });
  });

  it("drops blank transcriptions for an image", () => {
    const out = collectPrompts({ material: { kind: "image", png: new Uint8Array(), ocrText: "", width: 1, height: 1 }, extraction: { ...extraction, prompts: ["  ", "ok"] }, locators: [] });
    expect(out.prompts).toEqual(["ok"]);
  });

  it("locates against the text capture", () => {
    const out = collectPrompts({ material: { kind: "text", text: SOURCE }, extraction: null, locators: [{ start: "Act as", end: "fixes." }] });
    expect(out.prompts).toEqual(["Act as a senior reviewer.  List risks first, then fixes."]);
  });

  it("counts every locator unresolved when the page text could not be fetched", () => {
    const out = collectPrompts({ material: { kind: "url", url: "https://a.b", text: null }, extraction: null, locators: [{ start: "a", end: "b" }] });
    expect(out).toEqual({ prompts: [], unresolved: 1 });
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run lib/analysis/prompt-locate.test.ts`
Expected: FAIL（`Cannot find module './prompt-locate'`）

- [ ] **Step 4: 实现**

```ts
import { MAX_PROMPT_CHARS, MAX_PROMPTS, type Extraction } from "./card";
import type { Material } from "./material";

export interface PromptLocator { start: string; end: string }

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds `anchor` in `source` at or after `from`: exact first, then whitespace-insensitive
 * (each whitespace run in the anchor matches any whitespace run in the source). Returns the
 * source span, so whatever is sliced later is the source's own characters.
 */
function findAnchor(source: string, anchor: string, from: number): { index: number; end: number } | null {
  const needle = anchor.trim();
  if (!needle) return null;
  const exact = source.indexOf(needle, from);
  if (exact !== -1) return { index: exact, end: exact + needle.length };
  const pattern = new RegExp(needle.split(/\s+/).map(escapeRegExp).join("\\s+"), "g");
  pattern.lastIndex = from;
  const m = pattern.exec(source);
  return m ? { index: m.index, end: m.index + m[0].length } : null;
}

/**
 * Slices each located prompt out of `source` verbatim. Locators are resolved in order, each
 * searched from where the previous one ended; a locator whose anchors aren't both found, or
 * whose span exceeds MAX_PROMPT_CHARS, or that falls past MAX_PROMPTS, is dropped and counted
 * in `unresolved` -- never truncated or repaired.
 */
export function locatePrompts(source: string, locators: PromptLocator[]): { prompts: string[]; unresolved: number } {
  const prompts: string[] = [];
  let unresolved = 0;
  let cursor = 0;
  for (const locator of locators) {
    if (prompts.length >= MAX_PROMPTS) { unresolved += 1; continue; }
    const start = findAnchor(source, locator.start, cursor);
    const end = start ? findAnchor(source, locator.end, start.index) : null;
    if (!start || !end) { unresolved += 1; continue; }
    const stop = Math.max(end.end, start.end);
    const text = source.slice(start.index, stop);
    if (text.length > MAX_PROMPT_CHARS) { unresolved += 1; continue; }
    prompts.push(text);
    cursor = stop;
  }
  return { prompts, unresolved };
}

/**
 * The verbatim prompts for one analysis run, taken only from the input source: the vision
 * transcription for an image, or the reason step's locators resolved against the exact text
 * the reason prompt showed the model (the text capture, or the fetched page text).
 */
export function collectPrompts(input: { material: Material; extraction: Extraction | null; locators: PromptLocator[] }): { prompts: string[]; unresolved: number } {
  const { material, extraction, locators } = input;
  if (material.kind === "image") {
    const kept = (extraction?.prompts ?? []).filter((p) => p.trim() !== "" && p.length <= MAX_PROMPT_CHARS);
    return { prompts: kept.slice(0, MAX_PROMPTS), unresolved: 0 };
  }
  const source = material.text;
  if (source === null) return { prompts: [], unresolved: locators.length };
  return locatePrompts(source, locators);
}
```

注意：`Extraction` 在 Task 3 才有 `prompts` 字段，本任务的类型检查会失败——**Task 2 与 Task 3 连续执行，Task 3 结束时一起跑 typecheck**。本任务只跑 vitest（vitest 不做类型检查）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run lib/analysis/prompt-locate.test.ts`
Expected: PASS（7 + 4 个用例）

- [ ] **Step 6: Commit**

```bash
git add lib/analysis/prompt-locate.ts lib/analysis/prompt-locate.test.ts lib/analysis/card.ts
git commit -m "feat(caphub): locate verbatim prompts in the input source"
```

---

### Task 3: Schema 与提示词

**Files:**
- Modify: `lib/analysis/card.ts:6-13`（extraction）、`:27-31`（playbook）、`cardObjectSchema`（加 `prompt_locators`）
- Modify: `lib/analysis/prompts.ts`（`visionPrompt`、`reasonPrompt`、`enrichPrompt`）
- Modify: `lib/seed/demo.ts`
- Modify tests that build playbooks/extractions with `prompt_text`: `lib/analysis/card.test.ts`、`lib/analysis/prompts.test.ts`、`lib/analysis/scenarios.test.ts`、`lib/analysis/capabilities.test.ts`、`lib/analysis/enrich.test.ts`、`lib/analysis/pipeline.test.ts`、`lib/mcp/tools.test.ts`、`components/capability/components.test.tsx`、`components/review/review-card.test.tsx`、`app/(chrome)/library/[id]/page-sections.test.tsx`、`app/mini/page.test.tsx`

**Interfaces:**
- Consumes: `MAX_PROMPTS`、`MAX_PROMPT_CHARS`（Task 2）
- Produces:
  - `extractionSchema.prompts: string[]`（取代 `prompt_text`）
  - `cardObjectSchema.prompt_locators: PromptLocator[]`（`.default([])`）
  - `playbookSchema` 的 `integrate` 分支为 `{ kind, install, repo }`

- [ ] **Step 1: 写失败测试（`lib/analysis/card.test.ts` 末尾追加）**

```ts
describe("verbatim prompt fields", () => {
  it("extraction carries a list of transcribed prompts, capped at MAX_PROMPTS", () => {
    const base = { what: "w", visible_text: "", commands: [], source_hints: [], questions: [] };
    expect(extractionSchema.parse({ ...base, prompts: ["a", "b"] }).prompts).toEqual(["a", "b"]);
    expect(() => extractionSchema.parse({ ...base, prompts: Array(21).fill("x") })).toThrow();
  });

  it("integrate playbooks no longer carry prompt text", () => {
    const parsed = playbookSchema.parse({ kind: "integrate", install: [], repo: null, prompt_text: "legacy" });
    expect(parsed).toEqual({ kind: "integrate", install: [], repo: null });
  });

  it("cards default prompt_locators to [] and cap anchors short", () => {
    const shape = cardObjectSchema.shape.prompt_locators;
    expect(shape.parse(undefined)).toEqual([]);
    expect(() => shape.parse([{ start: "x".repeat(81), end: "y" }])).toThrow();
  });
});
```

（按需把 `extractionSchema`、`playbookSchema`、`cardObjectSchema` 加进该文件顶部的 import。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run lib/analysis/card.test.ts`
Expected: FAIL

- [ ] **Step 3: 改 `card.ts`**

```ts
export const extractionSchema = z.object({
  what: z.string().min(1).max(400),
  visible_text: z.string().max(8000),
  commands: z.array(z.string().max(500)).max(20),
  /** Every complete prompt visible in the image, transcribed verbatim, one entry each (spec 2026-09-22). */
  prompts: z.array(z.string().max(MAX_PROMPT_CHARS)).max(MAX_PROMPTS),
  source_hints: z.array(z.string().max(200)).max(10),
  questions: z.array(z.string().max(200)).max(5)
});
```

```ts
export const playbookSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("integrate"), install: z.array(z.string().max(500)).max(10), repo: z.string().min(1).max(300).nullable() }),
  z.object({ kind: z.literal("reference"), points: z.array(z.string().max(300)).min(1).max(10) }),
  z.object({ kind: z.literal("experience"), content: z.string().min(1).max(8000), when_to_use: z.string().max(300) })
]);
```

`cardObjectSchema` 在 `open_questions` 之后加：

```ts
  /**
   * Where each prompt sits in the text/url input -- the first and last ~20 characters, copied
   * from the source. Never stored: pipeline.ts resolves them with collectPrompts and stores the
   * source's own span in `capabilities.prompts` (spec 2026-09-22). Empty for images, whose
   * prompts come from the vision transcription instead.
   */
  prompt_locators: z.array(z.object({ start: z.string().min(1).max(80), end: z.string().min(1).max(80) })).max(MAX_PROMPTS).default([])
```

`MAX_PROMPTS` / `MAX_PROMPT_CHARS` 必须定义在 `extractionSchema` 之前（Task 2 Step 1 已放在 `capabilityTypeSchema` 之后）。

- [ ] **Step 4: 改 `prompts.ts`**

`visionPrompt` 的要求句改为：

```ts
    "要求：what 用一两句话说明图里展示的是什么能力；visible_text 抄录图中可见的关键文字；commands 抄录可见的安装/运行命令；prompts 列出图中每一条完整的提示词原文，每条单独一项、逐字抄录（包括标点、换行、参数如 --s 250），不翻译、不润色、不补全、不合并，中英对照的两个版本算两条，图中没有完整提示词就给空数组；source_hints 列出可见的作者、仓库、网址、产品名；questions 列出看图无法确定、需要联网核实的问题（最多 5 条）。",
```

`reasonPrompt`：
1. 把 `"playbook 按 usage/type 给可执行内容：integrate 给 install 命令、repo、prompt 全文；"` 改为 `"playbook 按 usage/type 给可执行内容：integrate 给 install 命令、repo；"`，并在它前面插入 `"prompt 原文由系统单独保存，不要在 summary、summary_points、playbook 里复述提示词原文；"`。
2. 在 `source_url` 那句之后追加一条（按素材分支）：

```ts
    input.material.kind === "image"
      ? "prompt_locators 给空数组：截图里的提示词原文已由视觉提取单独保存。"
      : "prompt_locators 标出「原始输入」里每一条完整提示词原文的位置，每条一项、按出现顺序：start 是这条提示词开头约 20 个字，end 是结尾约 20 个字，二者都必须从原始输入里逐字照抄（包括标点与空格，不翻译、不改写）；原始输入里没有提示词就给空数组。",
```

`enrichPrompt` 里 `"playbook 按 usage/type 给可执行内容：integrate 给 install 命令、repo、prompt 全文；"` 同样改为 `"prompt 原文由系统单独保存，不要在 summary、summary_points、playbook 里复述提示词原文；playbook 按 usage/type 给可执行内容：integrate 给 install 命令、repo；"`。

`deep.ts` 的输出没有 playbook，不改。

- [ ] **Step 5: 加提示词测试（`lib/analysis/prompts.test.ts`）**

```ts
it("asks vision for verbatim prompts and reason for locators on text, never for prompt 全文", () => {
  expect(visionPrompt("")).toContain("逐字抄录");
  const common = { extraction: null, sources: [], similar: [], existingTags: [], scenarios: [{ slug: "coding", labelZh: "编程", labelEn: "Coding", keywords: [] }] };
  const text = reasonPrompt({ ...common, material: { kind: "text", text: "hi" } } as never);
  expect(text).toContain("prompt_locators 标出");
  expect(text).not.toContain("prompt 全文");
  const image = reasonPrompt({ ...common, material: { kind: "image", png: new Uint8Array(), ocrText: "", width: 1, height: 1 } } as never);
  expect(image).toContain("prompt_locators 给空数组");
});
```

（`scenarios` 的字段名以 `lib/analysis/scenarios.ts` 的 `Scenario` 类型为准，写测试前先 `grep -n "export interface Scenario" -A6 lib/analysis/scenarios.ts` 核对。）

- [ ] **Step 6: 更新 `lib/seed/demo.ts`**

把 demo 第 198–202 行那张卡的 `prompt_text` 移出 playbook：playbook 改为 `{ kind: "integrate", install: [...原值], repo: ...原值 }`，在同一个 capability 对象上加 `prompts: ["你是一个信息整理助手。给定多篇来源文本，输出：1) 一句话标题；2) 3-5 条要点，每条标注对应来源编号；3) 若来源之间有冲突，单独列出。不要编造来源中没有的信息。"]`；其余几张卡删掉 `prompt_text: null`。给 capability 数据类型加 `prompts?: string[]`，并把第 435 行的 INSERT 扩成：

```ts
        `INSERT INTO caphub_v2.capabilities
           (id, capture_id, run_id, title, type, summary, summary_points, signals, suggested_verdict, suggested_reason, confidence,
            verdict, verdict_by, verdict_at, usage, playbook, tags, source_url, prompts)
         VALUES ($1,$2,$3,$4,$5,$6,$17::jsonb,$7,$8,$9,$10,$11,$12, CASE WHEN $12::text IS NULL THEN NULL ELSE now() END, $13,$14,$15,$16,$18::jsonb)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
```

参数数组末尾追加 `jsonStringifyStripNul((cap.prompts ?? []).map((text) => ({ text })))`。

- [ ] **Step 7: 修测试夹具**

Run: `grep -rln "prompt_text" lib app components scripts`
把每处夹具里的 `prompt_text` 删掉（integrate playbook）或改成 `prompts: []`（extraction）。**`lib/analysis/pipeline.test.ts` 顶部的默认 `card` 把 `type: "prompt"` 改成 `type: "skill"`**：它代表「普通卡」，而 Task 5 的新规则会让没有原文的 prompt 卡进 Review，保留 `prompt` 会让一批与本功能无关的用例误失败。

- [ ] **Step 8: 跑全部检查**

Run: `npm run typecheck && npm test`
Expected: 全部 PASS。若 `lib/analysis/structured.ts` 的 JSON Schema 转换对 `.default([])` 有特殊处理，按 `scenariosSchema`（同样 `.default([])`）现有的方式处理即可。

- [ ] **Step 9: Commit**

```bash
git add -A lib app components
git commit -m "feat(caphub): prompts come from vision transcription or source locators, never from reason"
```

---

### Task 4: 网页抓取保留换行

**Files:**
- Modify: `lib/analysis/material/url.ts`
- Test: `lib/analysis/material/url.test.ts`

**Interfaces:**
- Produces: `export function htmlToText(html: string): string`；`MAX_URL_BODY_BYTES = 102_400`；`fetchUrlText` 返回保留换行的正文。

- [ ] **Step 1: 写失败测试**

```ts
describe("htmlToText", () => {
  it("keeps block and <br> boundaries as line breaks and collapses runs of spaces within a line", () => {
    expect(htmlToText("<div><p>第一行</p><p>第二行  有  空格<br>第三行</p></div><script>x()</script>"))
      .toBe("第一行\n第二行 有 空格\n第三行");
  });
  it("keeps <pre> content's own line breaks", () => {
    expect(htmlToText("<pre>line 1\n  line 2</pre>")).toBe("line 1\n line 2");
  });
});
```

并把 `it("caps body to 20480 bytes", ...)` 改为：

```ts
  it("caps body to MAX_URL_BODY_BYTES", async () => {
    const fetchFn = (async () => new Response("<p>" + "a".repeat(200_000) + "</p>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const t = await fetchUrlText("https://a.b/", fetchFn, publicLookup);
    expect(t!.length).toBeLessThanOrEqual(MAX_URL_BODY_BYTES);
  });

  it("keeps line breaks in plain-text bodies", async () => {
    const fetchFn = (async () => new Response("a\n\n\nb   c", { status: 200, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    expect(await fetchUrlText("https://a.b/", fetchFn, publicLookup)).toBe("a\n\nb c");
  });
```

（import 加 `htmlToText`、`MAX_URL_BODY_BYTES`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run lib/analysis/material/url.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
export const MAX_URL_BODY_BYTES = 102_400;
```

```ts
const BLOCK_TAGS = "p|div|br|li|ul|ol|h[1-6]|pre|blockquote|tr|section|article|header|footer|hr";

/** Collapses spaces/tabs inside each line, trims each line, and keeps at most one blank line in a row. */
function tidyLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\r]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Like stripHtml, but keeps block-level and <br> boundaries as line breaks, so a prompt's own
 * line structure survives and prompt locators (prompt-locate.ts) slice it back out intact.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
  return tidyLines(text);
}
```

`fetchUrlText` 末尾改为：

```ts
      return stripNul(type.includes("html") ? htmlToText(raw) : tidyLines(raw));
```

`&amp;` 放在实体解码最后，避免 `&amp;lt;` 被二次解码成 `<`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run lib/analysis/material`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/analysis/material/url.ts lib/analysis/material/url.test.ts
git commit -m "feat(caphub): keep page line breaks and read up to 100 KB so prompts survive intact"
```

---

### Task 5: 分析流程接线（裁决 + 写入）

**Files:**
- Modify: `lib/analysis/verdict.ts`、`lib/analysis/capabilities.ts`、`lib/analysis/pipeline.ts`
- Test: `lib/analysis/verdict.test.ts`、`lib/analysis/capabilities.test.ts`、`lib/analysis/pipeline.test.ts`、`lib/analysis/enrich.test.ts`

**Interfaces:**
- Consumes: `collectPrompts`（Task 2）、`card.prompt_locators`（Task 3）
- Produces:
  - `decideVerdict(card: Pick<Card, "suggested_verdict" | "confidence" | "type">, threshold: number, prompts: { count: number; unresolved: number })`
  - `upsertCapability` 的 `row` 新增 `prompts: string[]; promptUnresolved: number`

- [ ] **Step 1: 裁决测试（`verdict.test.ts` 追加，并给已有用例补 `type: "skill"` 与第三参数 `{ count: 0, unresolved: 0 }`）**

```ts
  it("sends a prompt card with no verbatim prompt to review even when confident", () => {
    expect(decideVerdict({ suggested_verdict: "keep", confidence: 0.95, type: "prompt" }, 0.8, { count: 0, unresolved: 0 })).toEqual({ verdict: "pending", by: null });
  });
  it("still auto-discards a confident discard with no prompt", () => {
    expect(decideVerdict({ suggested_verdict: "discard", confidence: 0.95, type: "prompt" }, 0.8, { count: 0, unresolved: 0 })).toEqual({ verdict: "discard", by: "auto" });
  });
  it("sends any card with an unresolved prompt to review", () => {
    expect(decideVerdict({ suggested_verdict: "keep", confidence: 0.95, type: "skill" }, 0.8, { count: 1, unresolved: 1 })).toEqual({ verdict: "pending", by: null });
    expect(decideVerdict({ suggested_verdict: "discard", confidence: 0.95, type: "skill" }, 0.8, { count: 0, unresolved: 2 })).toEqual({ verdict: "pending", by: null });
  });
  it("auto-keeps a prompt card that has its verbatim prompt", () => {
    expect(decideVerdict({ suggested_verdict: "keep", confidence: 0.95, type: "prompt" }, 0.8, { count: 1, unresolved: 0 })).toEqual({ verdict: "keep", by: "auto" });
  });
```

- [ ] **Step 2: 实现 `verdict.ts`**

```ts
import type { Card } from "./card";

/**
 * Confident suggestions apply automatically, except (spec 2026-09-22) when a prompt the source
 * contains could not be located verbatim, or a prompt card would be kept with no verbatim
 * prompt at all -- both go to Review so a human checks against the original capture.
 */
export function decideVerdict(
  card: Pick<Card, "suggested_verdict" | "confidence" | "type">,
  threshold: number,
  prompts: { count: number; unresolved: number }
): { verdict: "keep" | "discard" | "pending"; by: "auto" | null } {
  if (prompts.unresolved > 0) return { verdict: "pending", by: null };
  if (card.type === "prompt" && prompts.count === 0 && card.suggested_verdict === "keep") return { verdict: "pending", by: null };
  if (card.confidence >= threshold) return { verdict: card.suggested_verdict, by: "auto" };
  return { verdict: "pending", by: null };
}
```

- [ ] **Step 3: upsert 测试（`capabilities.test.ts`）**

先读该文件现有用例的 fake 写法，再加一条：调用 `upsertCapability(fake, { ...现有参数, prompts: ["原文一", "原文二"], promptUnresolved: 1 })`，断言 SQL 含 `prompts = excluded.prompts` 与 `prompt_unresolved = excluded.prompt_unresolved`，且参数里有 `JSON.stringify([{ text: "原文一" }, { text: "原文二" }])` 和 `1`。

- [ ] **Step 4: 实现 `capabilities.ts`**

`row` 类型加 `prompts: string[]; promptUnresolved: number`。INSERT 列表末尾加 `, prompts, prompt_unresolved`，VALUES 末尾加 `, $24::jsonb, $25`；`ON CONFLICT ... DO UPDATE SET` 里 `overlap = excluded.overlap,` 之后加：

```sql
         -- Verbatim prompts are re-taken from the input source on every run (spec 2026-09-22),
         -- never from a model, so a rerun simply replaces them.
         prompts = excluded.prompts, prompt_unresolved = excluded.prompt_unresolved,
```

参数数组末尾追加：

```ts
      jsonStringifyStripNul(row.prompts.map((text) => ({ text }))), row.promptUnresolved
```

- [ ] **Step 5: 流程测试（`pipeline.test.ts`）**

`deps()` 加选项 `sourceText?: string` 与 `extractionValue?: unknown`：`SELECT kind, object_key` 分支里 `text: kind === "text" ? (opts.sourceText ?? "hello") : null`；vision fake 返回 `opts.extractionValue ?? extraction`。顶部 `extraction` 夹具已在 Task 3 改为 `prompts: []`。新增用例：

```ts
  describe("verbatim prompts", () => {
    const promptCard = { ...card, type: "prompt", usage: "integrate", playbook: { kind: "integrate", install: [], repo: null } };

    it("stores the text capture's own span for each locator", async () => {
      const src = "前言\n你是助手。\n请逐条回答。\n后记";
      const { d, sql } = deps("text", { sourceText: src, reasonValue: { ...promptCard, prompt_locators: [{ start: "你是助手", end: "请逐条回答。" }] } });
      const out = await runPipeline(d, { runId: "r_p1", captureId: "c_p1", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
      expect(out.verdict).toBe("keep");
      const insert = sql.find((q) => q.text.includes("INSERT INTO caphub_v2.capabilities"))!;
      expect(insert.values).toContain(JSON.stringify([{ text: "你是助手。\n请逐条回答。" }]));
      expect(insert.values[24]).toBe(0);
    });

    it("sends the card to review when a locator is not in the source", async () => {
      const { d, sql } = deps("text", { sourceText: "别的内容", reasonValue: { ...promptCard, prompt_locators: [{ start: "不存在", end: "也不存在" }] } });
      const out = await runPipeline(d, { runId: "r_p2", captureId: "c_p2", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
      expect(out.verdict).toBe("pending");
      const insert = sql.find((q) => q.text.includes("INSERT INTO caphub_v2.capabilities"))!;
      expect(insert.values[24]).toBe(1);
    });

    it("sends a prompt card with no prompt found to review", async () => {
      const { d } = deps("text", { reasonValue: promptCard });
      const out = await runPipeline(d, { runId: "r_p3", captureId: "c_p3", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
      expect(out.verdict).toBe("pending");
    });

    it("stores the vision transcription for an image", async () => {
      const { d, sql } = deps("image", { reasonValue: promptCard, extractionValue: { ...extraction, prompts: ["逐字原文 --s 250"] } });
      const sharp = (await import("sharp")).default;
      const png = new Uint8Array(await sharp({ create: { width: 1, height: 1, channels: 3, background: "#fff" } }).png().toBuffer());
      d.objects = { get: async () => png } as never;
      await runPipeline(d, { runId: "r_p4", captureId: "c_p4", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
      const insert = sql.find((q) => q.text.includes("INSERT INTO caphub_v2.capabilities"))!;
      expect(insert.values).toContain(JSON.stringify([{ text: "逐字原文 --s 250" }]));
    });
  });
```

（`values[24]` 即 `$25`，`prompt_unresolved`。）

- [ ] **Step 6: 实现 `pipeline.ts`**

import `collectPrompts`（`./prompt-locate`）。把 `const decision = decideVerdict(card, deps.threshold);` 换成：

```ts
  // Verbatim prompts come from the input source only (spec 2026-09-22): the vision transcription
  // for an image, or the reason step's locators resolved against the same text it was shown.
  const found = collectPrompts({ material, extraction, locators: card.prompt_locators });
  const decision = decideVerdict(card, deps.threshold, { count: found.prompts.length, unresolved: found.unresolved });
```

`upsertCapability(db, {...})` 的参数对象加 `prompts: found.prompts, promptUnresolved: found.unresolved`。

- [ ] **Step 7: enrich 隔离测试（`enrich.test.ts`）**

找到断言 enrich 写回 SQL 的现有用例，追加：写回 SQL 文本不含 `prompts`、`prompt_unresolved`；enrich 发给模型的提示词不含 `prompt 全文`。

- [ ] **Step 8: 跑检查**

Run: `npm run typecheck && npx vitest run lib/analysis`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add lib/analysis
git commit -m "feat(caphub): store verbatim prompts with the card and route missing ones to review"
```

---

### Task 6: 读取端（查询 + MCP）

**Files:**
- Modify: `lib/library/queries.ts:13-24`（`CARD_COLUMNS`）、`:29-51`（`CapabilityRow`）
- Modify: `lib/mcp/tools.ts:90-110`
- Test: `lib/mcp/tools.test.ts`；所有构造 `CapabilityRow` 的测试夹具（typecheck 会逐个指出）

**Interfaces:**
- Produces: `CapabilityRow.prompts: Array<{ text: string }>`、`CapabilityRow.promptUnresolved: number`；MCP `get_capability` 输出 `prompts: string[]`。

- [ ] **Step 1: MCP 测试（`tools.test.ts`）**

在 `getCapability` 的现有用例里给 fake detail 加 `prompts: [{ text: "原文" }], promptUnresolved: 0`，断言输出 `prompts` 为 `["原文"]`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run lib/mcp/tools.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`CARD_COLUMNS` 在 `cb.build_notes AS "buildNotes",` 之后加 `cb.prompts, cb.prompt_unresolved AS "promptUnresolved",`。`CapabilityRow` 加：

```ts
  /** Verbatim prompts taken from the input source (spec 2026-09-22); `[]` when none. Never model-written. */
  prompts: Array<{ text: string }>;
  /** How many prompts the last analysis could not locate verbatim in the source; > 0 sends the card to Review. */
  promptUnresolved: number;
```

`tools.ts` 的 `getCapability` 返回对象在 `playbook: detail.playbook,` 之后加 `prompts: detail.prompts.map((p) => p.text),`。

- [ ] **Step 4: 修夹具并跑检查**

Run: `npm run typecheck`，把报错的 `CapabilityRow` 夹具补上 `prompts: [], promptUnresolved: 0`。然后 `npm test`。
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/library lib/mcp app components
git commit -m "feat(caphub): read verbatim prompts in library queries and MCP get_capability"
```

---

### Task 7: 展示（详情面板 + Review 提示）

**Files:**
- Create: `components/capability/source-prompts.tsx`、`components/capability/prompt-notice.tsx`
- Modify: `components/capability/playbook-view.tsx`、`components/capability/card-summary.tsx`
- Modify: `app/(chrome)/library/[id]/page.tsx:141-157`、`app/mini/library/[id]/page.tsx:111-122`
- Modify: `lib/i18n/dict-zh.ts`、`lib/i18n/dict-en.ts`、`app/globals.css`
- Test: `components/capability/source-prompts.test.tsx`、`components/capability/prompt-notice.test.tsx`、`components/capability/components.test.tsx`

**Interfaces:**
- Consumes: `CapabilityRow.prompts` / `promptUnresolved`（Task 6）
- Produces: `SourcePrompts({ prompts, locale })`、`PromptNotice({ type, prompts, promptUnresolved, locale })`、`playbookHasContent(playbook): boolean`

先读 `node_modules/next/dist/docs/` 里与 Server / Client Components 相关的指南（`CopyButton` 是 client component，面板本身是 server component）。

- [ ] **Step 1: 文案**

`dict-zh.ts` 的 `detail` 加：

```ts
    sourcePrompts: "Prompt 原文",
    promptIndex: "第 {n} 条",
```

`cardSummary` 加：

```ts
    promptUnresolved: "有 {count} 条 prompt 原文未能在投递内容里定位，请对照原始投递核对",
    promptMissing: "未摘到 prompt 原文，请对照原始投递补充或改判"
```

`dict-en.ts` 对应：

```ts
    sourcePrompts: "Source prompts",
    promptIndex: "#{n}",
```

```ts
    promptUnresolved: "{count} prompt(s) could not be located in the capture; check against the original",
    promptMissing: "No source prompt was captured; check against the original"
```

- [ ] **Step 2: 写失败测试**

`source-prompts.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourcePrompts } from "./source-prompts";

describe("SourcePrompts", () => {
  it("renders nothing without prompts", () => {
    const { container } = render(<SourcePrompts prompts={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders each prompt in full, keeping line breaks, with its own copy button", () => {
    const long = "第一行\n第二行 --s 250\n" + "字".repeat(5000);
    render(<SourcePrompts prompts={[{ text: long }, { text: "second" }]} />);
    expect(screen.getByRole("heading", { name: "Prompt 原文" })).toBeTruthy();
    const pres = document.querySelectorAll("pre");
    expect(pres).toHaveLength(2);
    expect(pres[0].textContent).toBe(long);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByText("第 1 条")).toBeTruthy();
  });

  it("omits the index label for a single prompt", () => {
    render(<SourcePrompts prompts={[{ text: "only" }]} />);
    expect(screen.queryByText("第 1 条")).toBeNull();
  });
});
```

`prompt-notice.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PromptNotice } from "./prompt-notice";

describe("PromptNotice", () => {
  it("warns about unresolved prompts on any type", () => {
    render(<PromptNotice type="skill" prompts={[{ text: "a" }]} promptUnresolved={2} />);
    expect(screen.getByText(/有 2 条 prompt 原文未能/)).toBeTruthy();
  });
  it("warns when a prompt card has no prompt", () => {
    render(<PromptNotice type="prompt" prompts={[]} promptUnresolved={0} />);
    expect(screen.getByText(/未摘到 prompt 原文/)).toBeTruthy();
  });
  it("renders nothing for a healthy card", () => {
    const { container } = render(<PromptNotice type="prompt" prompts={[{ text: "a" }]} promptUnresolved={0} />);
    expect(container.innerHTML).toBe("");
  });
});
```

`components.test.tsx`：找到断言 `PlaybookView` 渲染 `prompt_text` 的用例，改为断言 integrate playbook 不再渲染 `.prompt-block`；加 `playbookHasContent` 用例：

```tsx
it("playbookHasContent is false for an empty integrate playbook", () => {
  expect(playbookHasContent({ kind: "integrate", install: [], repo: null })).toBe(false);
  expect(playbookHasContent({ kind: "integrate", install: ["npm i x"], repo: null })).toBe(true);
  expect(playbookHasContent({ kind: "reference", points: ["p"] })).toBe(true);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run components/capability`
Expected: FAIL

- [ ] **Step 4: 实现组件**

`source-prompts.tsx`：

```tsx
import { format, getDict, type Locale } from "../../lib/i18n";
import { CopyButton } from "./copy-button";

/**
 * 「Prompt 原文」: the verbatim prompts taken from the input source (spec 2026-09-22), each in
 * full with its own copy button. Never model-written, so rendered as-is -- no truncation.
 */
export function SourcePrompts({ prompts, locale = "zh" }: { prompts: Array<{ text: string }>; locale?: Locale }) {
  if (prompts.length === 0) return null;
  const dict = getDict(locale);
  return (
    <section className="panel">
      <h2 className="panel-title">{dict.detail.sourcePrompts}</h2>
      <div className="source-prompts">
        {prompts.map((prompt, index) => (
          <div key={index} className="prompt-block">
            <div className="code-block__copy"><CopyButton text={prompt.text} label={dict.playbookView.copyAll} locale={locale} /></div>
            {prompts.length > 1 && <p className="source-prompts__index">{format(dict.detail.promptIndex, { n: index + 1 })}</p>}
            <pre>{prompt.text}</pre>
          </div>
        ))}
      </div>
    </section>
  );
}
```

`prompt-notice.tsx`：

```tsx
import type { CapabilityType } from "../../lib/analysis/card";
import { format, getDict, type Locale } from "../../lib/i18n";

/** Review hint for the two cases decideVerdict routes to Review for missing verbatim prompts. */
export function PromptNotice({ type, prompts, promptUnresolved, locale = "zh" }: {
  type: CapabilityType; prompts: Array<{ text: string }>; promptUnresolved: number; locale?: Locale;
}) {
  const dict = getDict(locale).cardSummary;
  if (promptUnresolved > 0) return <p className="prompt-notice">{format(dict.promptUnresolved, { count: promptUnresolved })}</p>;
  if (type === "prompt" && prompts.length === 0) return <p className="prompt-notice">{dict.promptMissing}</p>;
  return null;
}
```

`playbook-view.tsx`：删掉 integrate 分支里 `{playbook.prompt_text && (...)}` 整块；文件末尾加：

```ts
/** Whether 怎么用 has anything to show; an integrate card whose prompt moved to 「Prompt 原文」 may have nothing left. */
export function playbookHasContent(playbook: Playbook): boolean {
  if (playbook.kind === "integrate") return playbook.install.length > 0 || playbook.repo !== null;
  return true;
}
```

`card-summary.tsx`：import `PromptNotice`，在 `card-suggestion` 段落之后插入 `<PromptNotice type={row.type} prompts={row.prompts} promptUnresolved={row.promptUnresolved} locale={locale} />`。

- [ ] **Step 5: 挂到两个详情页**

两页都 import `SourcePrompts` 与 `playbookHasContent`。在 `<OpenQuestions ... />` 之后、「怎么用」`<section>` 之前插入 `<SourcePrompts prompts={detail.prompts} locale={locale} />`。「怎么用」整个 `<section>` 用条件包住：

```tsx
          {(playbookHasContent(detail.playbook) || (detail.sourceUrl && !sourceUrlIsDuplicate)) && (
            <section className="panel">
              ...原内容不变...
            </section>
          )}
```

- [ ] **Step 6: 样式（`app/globals.css`，放在 `.prompt-block pre` 规则之后）**

```css
.source-prompts > .prompt-block:first-child { margin-top: 0; }
.source-prompts__index { margin: 0 0 6px; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--ink-faint); }
.prompt-notice { margin: 6px 0; font-size: var(--text-sm); color: var(--amber-ink, var(--ink)); }
```

（`--amber-ink` 若不存在，先 `grep -n "\-\-amber" app/globals.css` 挑一个现有的强调色 token。）

- [ ] **Step 7: 跑检查**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS

- [ ] **Step 8: 本地浏览器检查**

1. 起一个临时 Neon branch（Task 10 Step 1 的同一个 branch 可复用；若尚未创建就在此创建），用该 branch 的连接串跑 `npm run migrate` 与 `npx tsx scripts/seed-demo.ts`（先读脚本头部确认它需要的环境变量），再 `npm run dev`。
2. 在 `localhost` 打开 demo 里那张 prompt 卡的详情页与 `/mini/library/<id>`，宽度 1440 与 390 各截一张图：「Prompt 原文」面板在「怎么用」之前、换行保留、复制按钮可用、无横向溢出；「怎么用」为空时不出现。
3. 打开 `/review`，确认 `PromptNotice` 文案出现在对应卡上（可在临时 branch 上手工 `UPDATE ... SET prompt_unresolved = 1, verdict = 'pending'` 造一张）。
截图存 `.agent/screens/verbatim-prompts/`。

- [ ] **Step 9: Commit**

```bash
git add components app lib/i18n
git commit -m "feat(caphub): show verbatim prompts in their own panel and flag missing ones in review"
```

---

### Task 8: 存量回填脚本

**Files:**
- Create: `scripts/backfill-prompts.ts`
- Test: `scripts/backfill-prompts.test.ts`

**Interfaces:**
- Consumes: 迁移 014 的两列；历史 `analysis_steps.output`（vision 步骤：旧格式 `prompt_text: string | null`，新格式 `prompts: string[]`）
- Produces: `export function pickBackfill(row: BackfillRow): { prompts: string[] } | { unresolved: string }`、`export async function runPromptBackfill(pool, apply, log): Promise<{ candidates: number; filled: number; unresolved: number }>`

规则（spec §4）：
1. 最近一次成功 vision 步骤的原文（新格式 `prompts` 优先，否则旧格式 `prompt_text`）非空 → 用它。
2. 否则若投递是文字、旧 `playbook.prompt_text` 非空、且逐字出现在 `captures.text` 里 → 用它。
3. 否则不写，列入待决定清单（`type = 'prompt'` 的卡，以及 playbook 里有 `prompt_text` 但没核实到来源的卡）。
4. 写入时同时删掉 `playbook.prompt_text`；**未能回填的卡保留 `playbook.prompt_text`**，等 Joey 决定，避免丢内容。
5. 不改 `updated_at`；`WHERE prompts = '[]'::jsonb` 防止覆盖重跑后已有的新原文。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { pickBackfill, runPromptBackfill, type BackfillRow } from "./backfill-prompts";

const base: BackfillRow = { id: "cab_1", serial: 27, type: "prompt", playbook: { kind: "reference", points: ["p"] }, capture_kind: "image", capture_text: null, vision_output: null };

describe("pickBackfill", () => {
  it("prefers the new-format vision prompts", () => {
    expect(pickBackfill({ ...base, vision_output: { prompts: ["A", "B"] } })).toEqual({ prompts: ["A", "B"] });
  });
  it("falls back to the old-format vision prompt_text", () => {
    expect(pickBackfill({ ...base, vision_output: { prompt_text: "原文" } })).toEqual({ prompts: ["原文"] });
  });
  it("accepts a text capture's playbook prompt only when it appears verbatim in the capture", () => {
    const row = { ...base, capture_kind: "text" as const, capture_text: "前言 你是助手。 后记", playbook: { kind: "integrate", install: [], repo: null, prompt_text: "你是助手。" } };
    expect(pickBackfill(row)).toEqual({ prompts: ["你是助手。"] });
    expect(pickBackfill({ ...row, playbook: { ...row.playbook, prompt_text: "改写过的" } })).toEqual({ unresolved: "text capture, playbook prompt not verbatim in source" });
  });
  it("reports an image card with no transcription as unresolved", () => {
    expect(pickBackfill({ ...base, vision_output: { prompt_text: null } })).toEqual({ unresolved: "no vision transcription" });
  });
});

describe("runPromptBackfill", () => {
  function fakePool(rows: BackfillRow[]) {
    const writes: Array<{ text: string; values: unknown[] }> = [];
    return {
      writes,
      pool: { query: async (text: string, values: unknown[] = []) => {
        if (text.trimStart().startsWith("SELECT")) return { rows };
        writes.push({ text, values });
        return { rows: [], rowCount: 1 };
      } }
    };
  }

  it("writes nothing in dry-run", async () => {
    const { pool, writes } = fakePool([{ ...base, vision_output: { prompt_text: "原文" } }]);
    const out = await runPromptBackfill(pool as never, false, () => {});
    expect(out).toEqual({ candidates: 1, filled: 1, unresolved: 0 });
    expect(writes).toHaveLength(0);
  });

  it("fills prompts, strips playbook.prompt_text and guards on an empty prompts column when applying", async () => {
    const { pool, writes } = fakePool([{ ...base, vision_output: { prompt_text: "原文" } }, { ...base, id: "cab_2" }]);
    const out = await runPromptBackfill(pool as never, true, () => {});
    expect(out).toEqual({ candidates: 2, filled: 1, unresolved: 1 });
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain("playbook - 'prompt_text'");
    expect(writes[0].text).toContain("prompts = '[]'::jsonb");
    expect(writes[0].text).not.toContain("updated_at");
    expect(writes[0].values).toEqual(["cab_1", JSON.stringify([{ text: "原文" }])]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run scripts/backfill-prompts.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
import type { Pool } from "pg";
import { MAX_PROMPT_CHARS } from "../lib/analysis/card";
import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { jsonStringifyStripNul } from "../lib/text/sanitize";

export interface BackfillRow {
  id: string; serial: number | null; type: string;
  playbook: { kind: string; prompt_text?: string | null; [key: string]: unknown };
  capture_kind: "image" | "text" | "url"; capture_text: string | null;
  /** Output of the capture's latest successful vision step: `{ prompts }` (new) or `{ prompt_text }` (old), or null. */
  vision_output: { prompts?: string[]; prompt_text?: string | null } | null;
}

/**
 * Picks a card's verbatim prompts from what is already stored -- no model call (spec §4). The
 * vision transcription was made from the original image at analysis time; a text capture's old
 * playbook prompt is only trusted if it appears verbatim in the capture.
 */
export function pickBackfill(row: BackfillRow): { prompts: string[] } | { unresolved: string } {
  const fromVision = (row.vision_output?.prompts ?? (row.vision_output?.prompt_text ? [row.vision_output.prompt_text] : []))
    .filter((p) => p.trim() !== "" && p.length <= MAX_PROMPT_CHARS);
  if (fromVision.length > 0) return { prompts: fromVision };
  const legacy = row.playbook.prompt_text;
  if (row.capture_kind === "text" && legacy) {
    return row.capture_text?.includes(legacy) ? { prompts: [legacy] } : { unresolved: "text capture, playbook prompt not verbatim in source" };
  }
  return { unresolved: row.capture_kind === "image" ? "no vision transcription" : `no verifiable source for a ${row.capture_kind} capture` };
}

const CANDIDATES = `
  SELECT cb.id, cb.serial, cb.type, cb.playbook, c.kind AS capture_kind, c.text AS capture_text,
    (SELECT s.output FROM caphub_v2.analysis_steps s JOIN caphub_v2.analysis_runs r ON r.id = s.run_id
     WHERE r.capture_id = cb.capture_id AND s.step = 'vision' AND s.ok
     ORDER BY s.id DESC LIMIT 1) AS vision_output
  FROM caphub_v2.capabilities cb JOIN caphub_v2.captures c ON c.id = cb.capture_id
  WHERE cb.deleted_at IS NULL AND cb.prompts = '[]'::jsonb
    AND (cb.type = 'prompt' OR cb.playbook ? 'prompt_text')
  ORDER BY cb.created_at`;

/**
 * Fills `prompts` and drops the legacy `playbook.prompt_text` in one UPDATE. Cards that can't be
 * filled keep their legacy text untouched for a human decision. `updated_at` is deliberately not
 * touched (a data move, not a re-analysis); `prompts = '[]'` guards against overwriting prompts a
 * concurrent rerun just stored.
 */
export async function runPromptBackfill(
  pool: Pick<Pool, "query">, apply: boolean, log: (o: Record<string, unknown>) => void
): Promise<{ candidates: number; filled: number; unresolved: number }> {
  const { rows } = await pool.query<BackfillRow>(CANDIDATES);
  log({ mode: apply ? "apply" : "dry-run", candidates: rows.length });
  let filled = 0;
  let unresolved = 0;
  for (const row of rows) {
    const pick = pickBackfill(row);
    if ("unresolved" in pick) {
      unresolved += 1;
      log({ capabilityId: row.id, serial: row.serial, type: row.type, unresolved: pick.unresolved });
      continue;
    }
    filled += 1;
    log({ capabilityId: row.id, serial: row.serial, type: row.type, prompts: pick.prompts, applied: apply });
    if (apply) {
      await pool.query(
        `UPDATE caphub_v2.capabilities SET prompts = $2::jsonb, playbook = playbook - 'prompt_text'
         WHERE id = $1 AND prompts = '[]'::jsonb`,
        [row.id, jsonStringifyStripNul(pick.prompts.map((text) => ({ text })))]
      );
    }
  }
  log({ filled, unresolved, mode: apply ? "apply" : "dry-run" });
  return { candidates: rows.length, filled, unresolved };
}

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const config = loadConfig(process.env, "script");
  const pool = createPool(config.databaseUrl);
  const log = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`);
  try {
    await runPromptBackfill(pool, apply, log);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`backfill-prompts failed: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
```

注：默认是 dry-run，`--apply` 才写，和 `backfill-score.ts` 一致（spec 写的是 `--dry-run` 开关，这里沿用仓库既有约定，效果相同）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run scripts/backfill-prompts.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-prompts.ts scripts/backfill-prompts.test.ts
git commit -m "feat(caphub): backfill verbatim prompts from stored vision transcriptions"
```

---

### Task 9: 全量检查 + 独立评审

- [ ] **Step 1:** `npm run typecheck && npm run lint && npm test && npm run build`，全部通过。
- [ ] **Step 2:** `grep -rn "prompt_text" lib app components scripts`：结果只能出现在 `scripts/backfill-prompts.ts`（读旧数据）及其测试、以及 `lib/analysis/card.test.ts` 里「旧字段被丢弃」的那条用例；其他地方出现即为遗漏。
- [ ] **Step 3:** 按 AGENTS.md「Review」：本改动涉及数据迁移与生产数据回填，派一个独立 reviewer agent 审整个 changeset（重点：原文是否可能被任何模型路径写入、upsert 参数序号、回填 WHERE 守卫、迁移可重放性），修掉阻塞项后重跑 Step 1。

---

### Task 10: 临时 Neon branch 预演 → Joey 确认 → 生产（需授权）

- [ ] **Step 1: 临时 branch**
用 Neon MCP 从生产 branch 建临时 branch `verbatim-prompts-rehearsal`，取 owner 连接串（通过 stdin 传给命令，不打印）。

- [ ] **Step 2: 迁移 + 回填预演**
在该 branch 上 `npm run migrate`，再 `tsx scripts/backfill-prompts.ts`（dry-run），然后 `--apply`。

- [ ] **Step 3: 列给 Joey 确认**
把 dry-run 输出整理成表：每张卡的编号、类型、回填的原文（全文）、未能回填的卡及原因。**停下等 Joey 确认，并就未能回填的卡逐张决定。**

- [ ] **Step 4: 生产（Joey 授权后）**
生产库 `npm run migrate`（迁移 014）→ `tsx scripts/backfill-prompts.ts --apply` → `git push`（Railway 自动部署）。按 `docs/deploy.md` 核对部署健康，并在线上打开一张 prompt 卡确认「Prompt 原文」面板。

- [ ] **Step 5: 清理**
删除临时 branch；在 `docs/` 写一份验证记录 `docs/verbatim-prompts-verification.md`（改了什么、检查结果、回填清单、遗留项）。
