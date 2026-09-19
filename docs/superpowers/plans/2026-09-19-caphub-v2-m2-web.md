# Caphub v2 — M2（Web 端）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Caphub web 做成可日常使用的界面：与 alljobs 一致的 Paper Workbench 外观，投递页、Review 页、能力库（含统计）、详情页，以及保留 / 丢弃 / 改建议 / 复核 / 重跑 / 软删除这些人工动作。

**Architecture:** Next.js 16 App Router 服务端组件读 Postgres（`lib/library/queries.ts`），写操作全部经 `lib/library/actions.ts` 的纯函数（带 `updated_at` 乐观锁），由 Server Actions 调用；M3 的 Telegram 会复用同一组函数。web 服务没有模型 key，所以“复核”只记录请求，由 worker 取走执行（`lib/worker/reviews.ts`）。样式为纯 CSS，从 alljobs `app/globals.css` 按行号复制并改名。

**Tech Stack:** Next.js 16.3 App Router + Server Actions · React 19 · TypeScript · pg · Vitest · Playwright（仅截图/冒烟）

**Spec:** `docs/superpowers/specs/2026-09-19-caphub-v2-design.md`（§4 数据模型、§5.4 复核、§5.5 裁决、§6 Web 端）

## Global Constraints

- 导航：`投递` · `Review` · `能力库`；Paper Workbench 风格沿用 alljobs；**不做 dashboard**；能力库顶部统计条（按类型计数、标签数、待 Review 数）。
- Review 卡六项：一句话（title）、类型、AI 建议 + 理由、摘要、原始输入（缩略图 / 文字 / URL）、拟打标签；其余（分析原文、来源、每步 token 与耗时）折叠在“详情”。
- Review 操作：保留 / 丢弃 / 改建议（类型、usage、标签；**保存即保留**）；冲突时卡片置灰提示“已在别处处理”。
- 能力库：默认 `verdict = 'keep'` 且未删除；筛选：类型、标签多选、usage、“已丢弃”开关；搜索：Postgres 全文检索。
- 详情：卡 + playbook（integrate → 可复制命令 / prompt 全文；reference → 要点；experience → 核心内容）；操作：改建议、复核、重跑、删除（软删，一次确认，无确认短语）；显示 `synced_at`。
- 软删除 30 天后随清扫硬删（spec §4）。
- 页面不出现内部 id（`cap_…` / `cab_…` / `run_…`）；只在“详情”折叠区里作为技术信息出现。
- 所有 UI 文案为中文。
- 标签规则沿用 `lib/analysis/card.ts` 的 `isValidTag`（英文小写、连字符，非保留词）。
- 人工把卡改为 keep 时累加标签计数（M1 裁决：只在进入 keep 的那一刻累加一次）。
- web 服务**没有**模型 key；复核必须在 worker 执行。
- 测试不连真实数据库或 provider（fake pool / fake fetch）；真实库只在 Task 10 的临时 Neon branch 上使用，用完删除。
- Next 16：写 Server Actions / route handler / proxy 相关代码前先读 `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md` 等对应文档。
- 提交信息末尾附：
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01V3fTcbCt4cPyeZoiv4eEPC`
- 来源仓库（只读）：`$ALLJOBS = /Users/xtation/AgentWorks/GPT_Workspace/alljobs`。

---

## 文件结构

```
app/
  globals.css                  # 重写：reset + tokens + shell + 组件类（Task 1）
  layout.tsx                   # 套 AppShell（Task 1）
  page.tsx, capture-form.tsx, recent-row.tsx   # 投递页重做（Task 6）
  review/page.tsx              # Review（Task 7）
  library/page.tsx             # 能力库（Task 8）
  library/[id]/page.tsx        # 详情（Task 9）
  actions.ts                   # Server Actions 薄封装（Task 4）
  api/objects/[...key]/route.ts# 缩略图（Task 2）
components/
  shell/app-shell.tsx, primary-nav.tsx, nav.ts   # Task 1
  capability/card-summary.tsx, verdict-badge.tsx, tag-list.tsx, capture-preview.tsx, analysis-details.tsx, playbook-view.tsx, copy-button.tsx  # Task 6
  review/review-card.tsx, suggestion-editor.tsx  # Task 7
lib/
  library/queries.ts           # 读模型（Task 3）
  library/actions.ts           # 写动作（Task 4）
  library/labels.ts            # 中文标签 / 错误码文案（Task 3）
  objects/serve.ts             # 缩略图处理（Task 2）
  worker/reviews.ts            # 复核执行（Task 5）
  db/migrations/003_review_requests.sql          # Task 4
  retention/retention.ts       # + 硬删软删满 30 天（Task 5）
scripts/
  worker.ts                    # + 复核 tick（Task 5）
  shot.mjs                     # 截图（Task 10）
  seed-demo.ts                 # 临时库演示数据（Task 10）
```

---

### Task 1: 样式体系与页面框架

**Files:**
- Rewrite: `app/globals.css`
- Modify: `app/layout.tsx`
- Create: `components/shell/nav.ts`, `components/shell/nav.test.ts`, `components/shell/primary-nav.tsx`, `components/shell/app-shell.tsx`

**Interfaces:**
- Produces: `NAV_ITEMS: readonly { href: string; label: string }[]`；`isNavCurrent(href: string, pathname: string): boolean`；`<AppShell>{children}</AppShell>`（client）。
- Produces CSS classes used by later tasks: `.page-head`, `.page-title`, `.page-subtitle`, `.panel`, `.btn`, `.btn--primary`, `.btn--danger`, `.badge` + `--keep|--discard|--pending|--type|--usage|--auto`, `.tag`, `.stat-bar`, `.stat`, `.list`, `.list-row`, `.empty`, `.kicker`, `.inline-error`, `.notice`, `.sr-only`（以及沿用的 `.caphub-*` 投递类）。

- [ ] **Step 1: 失败测试**

`components/shell/nav.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { NAV_ITEMS, isNavCurrent } from "./nav";

describe("nav", () => {
  it("has the three areas in order", () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(["投递", "Review", "能力库"]);
  });
  it("marks / only on exact match and others by prefix", () => {
    expect(isNavCurrent("/", "/")).toBe(true);
    expect(isNavCurrent("/", "/review")).toBe(false);
    expect(isNavCurrent("/library", "/library/abc")).toBe(true);
    expect(isNavCurrent("/library", "/libraryx")).toBe(false);
    expect(isNavCurrent("/review", "/review")).toBe(true);
  });
});
```

- [ ] **Step 2:** `npx vitest run components/shell` → FAIL（模块不存在）。确认 `vitest.config.ts` 的 include 覆盖 `components/**/*.test.ts`；若不覆盖，把 `"components/**/*.test.ts"` 加进 include。

- [ ] **Step 3: 实现导航**

`components/shell/nav.ts`:
```ts
export const NAV_ITEMS = [
  { href: "/", label: "投递" },
  { href: "/review", label: "Review" },
  { href: "/library", label: "能力库" }
] as const;

export function isNavCurrent(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
```

`components/shell/primary-nav.tsx`:
```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, isNavCurrent } from "./nav";

export function PrimaryNav() {
  const pathname = usePathname();
  return (
    <nav className="primary-nav" aria-label="主导航">
      {NAV_ITEMS.map((item) => (
        <Link key={item.href} href={item.href} aria-current={isNavCurrent(item.href, pathname) ? "page" : undefined}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
```

`components/shell/app-shell.tsx`:
```tsx
import Link from "next/link";
import type { ReactNode } from "react";
import { PrimaryNav } from "./primary-nav";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-layout">
      <a href="#main" className="skip-link">跳到正文</a>
      <header className="app-header">
        <Link href="/" className="brand" aria-label="Caphub 首页">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /><path d="M3 9h6" />
          </svg>
          <span className="brand__text">Caphub <span className="brand__sub">/ 能力库</span></span>
        </Link>
        <PrimaryNav />
      </header>
      <main id="main" className="main-content">{children}</main>
    </div>
  );
}
```

`app/layout.tsx`:
```tsx
import "./globals.css";
import type { ReactNode } from "react";
import { AppShell } from "../components/shell/app-shell";

export const metadata = { title: "Caphub" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body><AppShell>{children}</AppShell></body>
    </html>
  );
}
```

- [ ] **Step 4: 重写 `app/globals.css`**，按下面顺序组成，逐段复制时**只改注明的地方**：

1. Reset（新写，替代 Tailwind preflight 中 alljobs 依赖的部分）：
```css
h1, h2, h3, h4, h5, h6 { margin: 0; font-size: inherit; font-weight: inherit; }
p { margin: 0; }
ul, ol { margin: 0; padding: 0; list-style: none; }
img, svg { display: block; max-width: 100%; }
button, input, select, textarea { font: inherit; color: inherit; }
button { background: transparent; border: 0; padding: 0; cursor: pointer; }
a { color: inherit; }
```
2. 从 `$ALLJOBS/app/globals.css` 逐字复制：`:root` 与 `*, *::before, *::after`（约 290–332 行）、`body` / `:focus-visible` / `.skip-link`（334–360 行附近）、`.app-header` / `.brand` / `.primary-nav`（376–448 行）、`.main-content`（714–718）、`.badge` 基础类（599 行起的 `.badge { … }` 一条）、`.btn` / `.btn--primary`（886–917）、`.sr-only`（966–976）、`prefers-reduced-motion` 块（1175–1183）、≤600px 媒体查询中针对 `.app-header` / `.primary-nav` / `.main-content` 的三条（1129–1173 内）。行号以实际文件为准，按选择器名定位。
3. 从 `$ALLJOBS/app/globals.css` 逐字复制 Caphub 投递相关类：`.caphub-intro` … `.caphub-error`（40–156 行），以及 ≤720px 媒体查询里针对这些类的规则（127–153 行）。删除 `.caphub-custody*` 与 `.caphub-receipt*` 两组（v2 不用）。
4. 新增（v2 专用，逐字写入）：
```css
.brand__sub { color: var(--ink-muted); font-weight: 400; }
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; padding-bottom: 20px; margin-bottom: 24px; border-bottom: 1px solid var(--hairline-strong); }
.page-title { font-size: clamp(26px, 2.6vw, 36px); font-weight: 650; letter-spacing: -0.03em; line-height: 1.05; }
.page-subtitle { margin-top: 8px; color: var(--ink-muted); font-size: 15px; }
.kicker { color: var(--ink-faint); font-family: var(--font-mono); font-size: 10.5px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; }
.panel { background: var(--paper-raised); border: 1px solid var(--hairline-strong); border-radius: var(--radius-lg); padding: 20px; }
.btn--danger { color: var(--rust); border-color: var(--rust-border); }
.btn--danger:hover { background: var(--rust-soft); border-color: var(--rust); }
.btn:disabled { color: var(--ink-faint); background: var(--paper-recessed); border-color: var(--hairline); cursor: not-allowed; }
.badge--keep { background: var(--green-soft); border: 1px solid var(--green-border); color: var(--green); }
.badge--discard { background: var(--rust-soft); border: 1px solid var(--rust-border); color: var(--rust); }
.badge--pending { background: var(--amber-soft); border: 1px solid var(--amber-border); color: #7a4f00; }
.badge--type, .badge--usage { background: transparent; border: 1px solid var(--hairline-strong); color: var(--ink-muted); }
.badge--auto { background: var(--paper-recessed); border: 1px solid var(--hairline); color: var(--ink-faint); }
.tag { display: inline-flex; padding: 2px 7px; font-family: var(--font-mono); font-size: 11px; color: var(--ink-muted); background: var(--paper-recessed); border: 1px solid var(--hairline); border-radius: var(--radius-sm); }
.tag-list { display: flex; flex-wrap: wrap; gap: 6px; }
.stat-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-bottom: 24px; }
.stat { background: var(--paper-raised); border: 1px solid var(--hairline); border-radius: var(--radius-md); padding: 14px 16px; box-shadow: 0 1px 2px rgba(22, 20, 14, 0.04); }
.stat__label { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; color: var(--ink-faint); letter-spacing: 0.05em; }
.stat__value { margin-top: 4px; font-size: 26px; font-weight: 700; line-height: 1.1; }
.stat--accent { border-color: var(--amber-border); background: var(--amber-soft); }
.list { border-top: 1px solid var(--hairline-strong); }
.list-row { display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; align-items: center; gap: 16px; padding: 14px 8px; border-bottom: 1px solid var(--hairline); text-decoration: none; color: inherit; }
.list-row:hover { background: var(--paper-raised); }
.list-row__title { font-weight: 650; overflow-wrap: anywhere; }
.list-row__meta { margin-top: 4px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--ink-muted); font-size: 13px; }
.thumb { width: 56px; height: 56px; border-radius: var(--radius-md); border: 1px solid var(--hairline); background: var(--paper-recessed); object-fit: cover; display: grid; place-items: center; font-family: var(--font-mono); font-size: 10px; color: var(--ink-faint); overflow: hidden; }
.empty { padding: 18px; color: var(--ink-muted); background: var(--paper-raised); border: 1px dashed var(--hairline-strong); border-radius: var(--radius-lg); font-size: 14px; }
.inline-error { padding: 10px 12px; color: var(--rust); background: var(--rust-soft); border: 1px solid var(--rust-border); border-radius: var(--radius-md); font-size: 13px; }
.notice { padding: 10px 12px; background: var(--amber-soft); border: 1px solid var(--amber); border-radius: var(--radius-md); font-size: 13px; }
@media (max-width: 600px) {
  .page-head { flex-direction: column; align-items: flex-start; }
  .list-row { grid-template-columns: 44px minmax(0, 1fr); }
  .list-row > :last-child { grid-column: 2; }
  .thumb { width: 44px; height: 44px; }
}
```
删除旧的 `.section-nav` 规则（v2 不再用二级导航）。

- [ ] **Step 5:** `npx vitest run components/shell` → PASS；`npm run typecheck && npm run lint && npm run build` 通过。

- [ ] **Step 6: 提交**
```bash
git add app/globals.css app/layout.tsx components/shell vitest.config.ts
git commit -m "feat(web): Paper Workbench shell and style system from alljobs"
```

---

### Task 2: 缩略图接口

**Files:**
- Create: `lib/objects/serve.ts`, `lib/objects/serve.test.ts`, `app/api/objects/[...key]/route.ts`

**Interfaces:**
- Consumes: `ObjectStore.get(ref)`（`lib/storage/s3.ts`，bytes=0 时跳过长度校验）、`getRuntime()`（`lib/runtime.ts`）。
- Produces: `handleObjectRequest(key: string, deps: { pool: Pick<Pool, "query">; objects: Pick<ObjectStore, "get"> }): Promise<Response>`；URL 形如 `/api/objects/sha256/ab/<64hex>`。

- [ ] **Step 1: 失败测试**

`lib/objects/serve.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { handleObjectRequest } from "./serve";

const KEY = "sha256/ab/" + "a".repeat(64);
const pool = (rows: unknown[]) => ({ query: async () => ({ rows }) }) as never;
const objects = (bytes: Uint8Array | Error) => ({ get: async () => { if (bytes instanceof Error) throw bytes; return bytes; } }) as never;

describe("handleObjectRequest", () => {
  it("rejects malformed keys with 404 without touching the db", async () => {
    let queried = false;
    const res = await handleObjectRequest("../etc/passwd", { pool: { query: async () => { queried = true; return { rows: [] }; } } as never, objects: objects(new Uint8Array([1])) });
    expect(res.status).toBe(404);
    expect(queried).toBe(false);
  });
  it("404 when no capture references the key", async () => {
    const res = await handleObjectRequest(KEY, { pool: pool([]), objects: objects(new Uint8Array([1])) });
    expect(res.status).toBe(404);
  });
  it("streams bytes with the capture mime type and private caching", async () => {
    const res = await handleObjectRequest(KEY, { pool: pool([{ mime_type: "image/png" }]), objects: objects(new Uint8Array([1, 2, 3])) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("410 when the object has been purged", async () => {
    const res = await handleObjectRequest(KEY, { pool: pool([{ mime_type: "image/png" }]), objects: objects(new Error("NoSuchKey")) });
    expect(res.status).toBe(410);
  });
});
```

- [ ] **Step 2:** `npx vitest run lib/objects` → FAIL。

- [ ] **Step 3: 实现**

`lib/objects/serve.ts`:
```ts
import type { Pool } from "pg";
import type { ObjectStore } from "../storage/s3";

const KEY_RE = /^sha256\/[a-f0-9]{2}\/([a-f0-9]{64})$/;
const MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function handleObjectRequest(
  key: string,
  deps: { pool: Pick<Pool, "query">; objects: Pick<ObjectStore, "get"> }
): Promise<Response> {
  const m = KEY_RE.exec(key);
  if (!m) return new Response(null, { status: 404 });
  const row = (await deps.pool.query<{ mime_type: string | null }>(
    "SELECT mime_type FROM caphub_v2.captures WHERE object_key = $1 LIMIT 1", [key])).rows[0];
  if (!row || !row.mime_type || !MIMES.has(row.mime_type)) return new Response(null, { status: 404 });
  let bytes: Uint8Array;
  try {
    bytes = await deps.objects.get({ key, digest: m[1], bytes: 0 });
  } catch {
    return new Response(null, { status: 410 });
  }
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "content-type": row.mime_type,
      "cache-control": "private, max-age=86400, immutable",
      "x-content-type-options": "nosniff"
    }
  });
}
```

`app/api/objects/[...key]/route.ts`（先读 Next 16 文档确认动态段 params 是 Promise）：
```ts
import { handleObjectRequest } from "../../../../lib/objects/serve";
import { getRuntime } from "../../../../lib/runtime";

export async function GET(_request: Request, context: { params: Promise<{ key: string[] }> }) {
  const { key } = await context.params;
  const { pool, objects } = getRuntime();
  return handleObjectRequest(key.join("/"), { pool, objects });
}
```

- [ ] **Step 4:** `npx vitest run lib/objects` → PASS；`npm run typecheck && npm run build`。
- [ ] **Step 5:** 提交 `feat(web): access-guarded thumbnail route for capture images`。

---

### Task 3: 读模型与中文文案

**Files:**
- Create: `lib/library/queries.ts`, `lib/library/queries.test.ts`, `lib/library/labels.ts`, `lib/library/labels.test.ts`
- Modify: `lib/captures/captures.ts`（`listRecentCaptures` 增加字段）+ 其测试

**Interfaces:**
- Produces（全部在 `lib/library/queries.ts`）:
```ts
export interface CapabilityRow {
  id: string; captureId: string; title: string; type: CapabilityType; summary: string; signals: string[];
  suggestedVerdict: "keep" | "discard"; suggestedReason: string; confidence: number;
  verdict: "keep" | "discard" | "pending"; verdictBy: "auto" | "human" | null;
  usage: "integrate" | "reference"; playbook: Playbook; tags: string[]; sourceUrl: string | null;
  reviewNote: ReviewNote | null; reviewRequestedAt: string | null; reviewError: string | null;
  syncedAt: string | null; deletedAt: string | null; createdAt: string; updatedAt: string;
  capture: { kind: "image" | "text" | "url"; objectKey: string | null; text: string | null; url: string | null };
}
export function listPending(pool, opts: { page: number }): Promise<{ items: CapabilityRow[]; total: number }>;
export interface LibraryFilter { q?: string; types?: CapabilityType[]; tags?: string[]; usage?: "integrate" | "reference"; discarded?: boolean; page: number }
export function listLibrary(pool, filter: LibraryFilter): Promise<{ items: CapabilityRow[]; total: number }>;
export interface LibraryStats { byType: Record<CapabilityType, number>; total: number; tagCount: number; pending: number }
export function libraryStats(pool): Promise<LibraryStats>;
export function allTags(pool): Promise<Array<{ name: string; count: number }>>;
export interface StepSummary { step: string; provider: string; model: string; attempt: number; ok: boolean; error: string | null; durationMs: number; inputTokens: number | null; outputTokens: number | null }
export interface CapabilityDetail extends CapabilityRow { steps: StepSummary[]; sources: Array<{ title: string; url: string }>; runPipeline: string; runState: string }
export function getCapabilityDetail(pool, id: string): Promise<CapabilityDetail | null>;
export const PAGE_SIZE = 20;
```
- `lib/library/labels.ts`:
```ts
export const TYPE_LABEL: Record<CapabilityType, string>;   // skill→技能, experience→经验, plugin→插件, prompt→提示词, other→其他
export const USAGE_LABEL: Record<"integrate" | "reference", string>; // 直接整合 / 参考自研
export const VERDICT_LABEL: Record<"keep" | "discard" | "pending", string>; // 保留 / 丢弃 / 待决
export const RUN_STATE_LABEL: Record<"queued" | "running" | "done" | "failed", string>; // 排队中 / 分析中 / 已建卡 / 失败
export function errorLabel(code: string | null): string; // 见下
```
- `listRecentCaptures` 返回值增加：`objectKey: string | null; text: string | null; url: string | null; title: string | null; verdict: "keep" | "discard" | "pending" | null; deleted: boolean`。

- [ ] **Step 1: 失败测试**（fake pool 记录 SQL 与参数；断言关键 SQL 片段与参数，而不是整条 SQL）

`lib/library/labels.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { TYPE_LABEL, errorLabel } from "./labels";

describe("labels", () => {
  it("maps types to Chinese", () => { expect(TYPE_LABEL.experience).toBe("经验"); });
  it("maps known error codes and falls back", () => {
    expect(errorLabel("OBJECT_UNAVAILABLE")).toBe("原图已过期，无法重跑");
    expect(errorLabel("BUDGET")).toBe("超出单次分析预算");
    expect(errorLabel("SOMETHING")).toBe("分析失败（SOMETHING）");
    expect(errorLabel(null)).toBe("");
  });
});
```

`lib/library/queries.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { listLibrary, listPending, libraryStats, getCapabilityDetail, PAGE_SIZE } from "./queries";

function recorder(rows: unknown[][]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let i = 0;
  return { calls, pool: { query: async (text: string, values: unknown[] = []) => { calls.push({ text, values }); return { rows: rows[i++] ?? [] }; } } as never };
}

describe("library queries", () => {
  it("listPending filters pending, not deleted, newest first, paged", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listPending(pool, { page: 2 });
    expect(calls[0].text).toMatch(/cb\.verdict = 'pending'/);
    expect(calls[0].text).toMatch(/cb\.deleted_at IS NULL/);
    expect(calls[0].text).toMatch(/ORDER BY cb\.created_at DESC/);
    expect(calls[0].values).toEqual([PAGE_SIZE, PAGE_SIZE]);
  });
  it("listLibrary defaults to keep and applies search/type/tag/usage filters as parameters", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool, { q: "web scraping", types: ["skill"], tags: ["python"], usage: "integrate", page: 1 });
    const { text, values } = calls[0];
    expect(text).toMatch(/cb\.verdict = 'keep'/);
    expect(text).toMatch(/websearch_to_tsquery\('simple', \$\d+\)/);
    expect(text).toMatch(/cb\.type = ANY\(\$\d+\)/);
    expect(text).toMatch(/cb\.tags @> \$\d+/);
    expect(text).toMatch(/cb\.usage = \$\d+/);
    expect(values).toEqual(expect.arrayContaining(["web scraping", ["skill"], ["python"], "integrate"]));
  });
  it("listLibrary with discarded=true lists discarded instead of kept", async () => {
    const { pool, calls } = recorder([[], [{ total: "0" }]]);
    await listLibrary(pool, { discarded: true, page: 1 });
    expect(calls[0].text).toMatch(/cb\.verdict = 'discard'/);
  });
  it("libraryStats counts kept by type, distinct tags of kept, and pending", async () => {
    const { pool } = recorder([[{ type: "skill", n: "3" }, { type: "prompt", n: "1" }], [{ n: "7" }], [{ n: "2" }]]);
    const s = await libraryStats(pool);
    expect(s.byType.skill).toBe(3);
    expect(s.byType.experience).toBe(0);
    expect(s.total).toBe(4);
    expect(s.tagCount).toBe(7);
    expect(s.pending).toBe(2);
  });
  it("getCapabilityDetail returns null when missing", async () => {
    const { pool } = recorder([[]]);
    expect(await getCapabilityDetail(pool, "cab_x")).toBeNull();
  });
});
```

- [ ] **Step 2:** 运行确认失败。

- [ ] **Step 3: 实现**

`lib/library/labels.ts`:
```ts
import type { CapabilityType } from "../analysis/card";

export const TYPE_LABEL: Record<CapabilityType, string> = { skill: "技能", experience: "经验", plugin: "插件", prompt: "提示词", other: "其他" };
export const USAGE_LABEL = { integrate: "直接整合", reference: "参考自研" } as const;
export const VERDICT_LABEL = { keep: "保留", discard: "丢弃", pending: "待决" } as const;
export const RUN_STATE_LABEL = { queued: "排队中", running: "分析中", done: "已建卡", failed: "失败" } as const;

const ERRORS: Record<string, string> = {
  OBJECT_UNAVAILABLE: "原图已过期，无法重跑",
  BUDGET: "超出单次分析预算",
  TIMEOUT: "模型响应超时",
  INVALID_OUTPUT: "模型输出不合规（已重试）",
  AUTHENTICATION: "模型 key 无效",
  BILLING: "模型额度不足或被限流",
  UNAVAILABLE: "模型服务不可用",
  LEASE_EXPIRED: "分析进程中断次数过多",
  PIPELINE_UNAVAILABLE: "分析管线未配置",
  CAPTURE_NOT_FOUND: "投递记录不存在",
  INVALID_IMAGE: "图片无法解析",
  INTERNAL: "内部错误"
};

export function errorLabel(code: string | null): string {
  if (!code) return "";
  return ERRORS[code] ?? `分析失败（${code}）`;
}
```

`lib/library/queries.ts`：
```ts
import type { Pool } from "pg";
import type { CapabilityType, Playbook, ReviewNote } from "../analysis/card";

export const PAGE_SIZE = 20;
type Q = Pick<Pool, "query">;

const CARD_COLUMNS = `
  cb.id, cb.capture_id AS "captureId", cb.title, cb.type, cb.summary, cb.signals,
  cb.suggested_verdict AS "suggestedVerdict", cb.suggested_reason AS "suggestedReason", cb.confidence,
  cb.verdict, cb.verdict_by AS "verdictBy", cb.usage, cb.playbook, cb.tags, cb.source_url AS "sourceUrl",
  cb.review_note AS "reviewNote", cb.review_requested_at AS "reviewRequestedAt", cb.review_error AS "reviewError",
  cb.synced_at AS "syncedAt", cb.deleted_at AS "deletedAt", cb.created_at AS "createdAt", cb.updated_at AS "updatedAt",
  json_build_object('kind', c.kind, 'objectKey', c.object_key, 'text', c.text, 'url', c.url) AS capture`;

export interface CapabilityRow {
  id: string; captureId: string; title: string; type: CapabilityType; summary: string; signals: string[];
  suggestedVerdict: "keep" | "discard"; suggestedReason: string; confidence: number;
  verdict: "keep" | "discard" | "pending"; verdictBy: "auto" | "human" | null;
  usage: "integrate" | "reference"; playbook: Playbook; tags: string[]; sourceUrl: string | null;
  reviewNote: ReviewNote | null; reviewRequestedAt: string | null; reviewError: string | null;
  syncedAt: string | null; deletedAt: string | null; createdAt: string; updatedAt: string;
  capture: { kind: "image" | "text" | "url"; objectKey: string | null; text: string | null; url: string | null };
}

function toIso<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const [k, v] of Object.entries(out)) if (v instanceof Date) out[k] = v.toISOString();
  return out as T;
}

async function paged(pool: Q, where: string, values: unknown[], page: number) {
  const p = Math.max(1, Math.floor(page) || 1);
  const n = values.length;
  const items = (await pool.query<CapabilityRow>(
    `SELECT ${CARD_COLUMNS} FROM caphub_v2.capabilities cb JOIN caphub_v2.captures c ON c.id = cb.capture_id
     WHERE ${where} ORDER BY cb.created_at DESC LIMIT $${n + 1} OFFSET $${n + 2}`,
    [...values, PAGE_SIZE, (p - 1) * PAGE_SIZE])).rows.map(toIso);
  const total = Number((await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM caphub_v2.capabilities cb WHERE ${where}`, values)).rows[0]?.total ?? 0);
  return { items, total };
}

export function listPending(pool: Q, opts: { page: number }) {
  return paged(pool, "cb.verdict = 'pending' AND cb.deleted_at IS NULL", [], opts.page);
}

export interface LibraryFilter { q?: string; types?: CapabilityType[]; tags?: string[]; usage?: "integrate" | "reference"; discarded?: boolean; page: number }

export function listLibrary(pool: Q, f: LibraryFilter) {
  const clauses = [`cb.verdict = '${f.discarded ? "discard" : "keep"}'`, "cb.deleted_at IS NULL"];
  const values: unknown[] = [];
  const add = (sql: (i: number) => string, v: unknown) => { values.push(v); clauses.push(sql(values.length)); };
  if (f.q?.trim()) add((i) => `cb.search @@ websearch_to_tsquery('simple', $${i})`, f.q.trim());
  if (f.types?.length) add((i) => `cb.type = ANY($${i})`, f.types);
  if (f.tags?.length) add((i) => `cb.tags @> $${i}`, f.tags);
  if (f.usage) add((i) => `cb.usage = $${i}`, f.usage);
  return paged(pool, clauses.join(" AND "), values, f.page);
}

export interface LibraryStats { byType: Record<CapabilityType, number>; total: number; tagCount: number; pending: number }

export async function libraryStats(pool: Q): Promise<LibraryStats> {
  const byType: Record<CapabilityType, number> = { skill: 0, experience: 0, plugin: 0, prompt: 0, other: 0 };
  const rows = (await pool.query<{ type: CapabilityType; n: string }>(
    "SELECT type, count(*)::text AS n FROM caphub_v2.capabilities WHERE verdict = 'keep' AND deleted_at IS NULL GROUP BY type")).rows;
  for (const r of rows) byType[r.type] = Number(r.n);
  const tagCount = Number((await pool.query<{ n: string }>(
    "SELECT count(DISTINCT t)::text AS n FROM caphub_v2.capabilities, unnest(tags) AS t WHERE verdict = 'keep' AND deleted_at IS NULL")).rows[0]?.n ?? 0);
  const pending = Number((await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM caphub_v2.capabilities WHERE verdict = 'pending' AND deleted_at IS NULL")).rows[0]?.n ?? 0);
  return { byType, total: Object.values(byType).reduce((a, b) => a + b, 0), tagCount, pending };
}

export async function allTags(pool: Q): Promise<Array<{ name: string; count: number }>> {
  const r = await pool.query<{ name: string; count: string }>(
    `SELECT t AS name, count(*)::text AS count FROM caphub_v2.capabilities, unnest(tags) AS t
     WHERE verdict = 'keep' AND deleted_at IS NULL GROUP BY t ORDER BY count(*) DESC, t LIMIT 200`);
  return r.rows.map((x) => ({ name: x.name, count: Number(x.count) }));
}

export interface StepSummary { step: string; provider: string; model: string; attempt: number; ok: boolean; error: string | null; durationMs: number; inputTokens: number | null; outputTokens: number | null }
export interface CapabilityDetail extends CapabilityRow { steps: StepSummary[]; sources: Array<{ title: string; url: string }>; runPipeline: string; runState: string }

export async function getCapabilityDetail(pool: Q, id: string): Promise<CapabilityDetail | null> {
  const row = (await pool.query<CapabilityRow & { runPipeline: string; runState: string; runId: string }>(
    `SELECT ${CARD_COLUMNS}, r.pipeline AS "runPipeline", r.state AS "runState", r.id AS "runId"
     FROM caphub_v2.capabilities cb JOIN caphub_v2.captures c ON c.id = cb.capture_id
     JOIN caphub_v2.analysis_runs r ON r.id = cb.run_id WHERE cb.id = $1`, [id])).rows[0];
  if (!row) return null;
  const steps = (await pool.query<StepSummary & { output: unknown }>(
    `SELECT step, provider, model, attempt, ok, error, duration_ms AS "durationMs", input_tokens AS "inputTokens",
            output_tokens AS "outputTokens", CASE WHEN step = 'search' AND ok THEN output ELSE NULL END AS output
     FROM caphub_v2.analysis_steps WHERE run_id = $1 ORDER BY id`, [row.runId])).rows;
  const search = steps.find((s) => s.step === "search" && s.ok)?.output as { sources?: Array<{ title: string; url: string }> } | undefined;
  const { runId: _runId, ...rest } = toIso(row);
  void _runId;
  return {
    ...rest,
    steps: steps.map(({ output: _o, ...s }) => { void _o; return s; }),
    sources: (search?.sources ?? []).map((s) => ({ title: s.title, url: s.url }))
  };
}
```
注意：`review_requested_at` / `review_error` 列由 Task 4 的迁移 003 新增；本任务的单元测试用 fake pool，不依赖真实列。

`lib/captures/captures.ts` 的 `listRecentCaptures` SELECT 增加：`c.object_key AS "objectKey", left(c.text, 140) AS text, c.url, cb.title, cb.verdict, (cb.deleted_at IS NOT NULL) AS deleted`，并更新 `RecentCapture` 接口与测试。

- [ ] **Step 4:** `npx vitest run lib/library lib/captures` → PASS；typecheck。
- [ ] **Step 5:** 提交 `feat(library): read models and Chinese labels for web pages`。

---

### Task 4: 写动作（决定 / 改建议 / 软删 / 重跑 / 请求复核）+ 迁移 003

**Files:**
- Create: `lib/db/migrations/003_review_requests.sql`, `lib/library/actions.ts`, `lib/library/actions.test.ts`, `app/actions.ts`

**Interfaces:**
- Consumes: `bumpTags(db, tags)`（`lib/analysis/tags.ts`）、`isValidTag`、`capabilityTypeSchema`（`lib/analysis/card.ts`）、`newId`、`Pipeline`。
- Produces（`lib/library/actions.ts`）:
```ts
export type ActionResult = { ok: true; updatedAt: string } | { ok: false; reason: "CONFLICT" | "NOT_FOUND" | "INVALID" | "OBJECT_GONE"; message: string };
export function decide(pool: Pool, input: { id: string; expectedUpdatedAt: string; verdict: "keep" | "discard" }): Promise<ActionResult>;
export function editSuggestion(pool: Pool, input: { id: string; expectedUpdatedAt: string; type: CapabilityType; usage: "integrate" | "reference"; tags: string[] }): Promise<ActionResult>;
export function softDelete(pool: Pool, input: { id: string; expectedUpdatedAt: string }): Promise<ActionResult>;
export function requestRerun(pool: Pool, input: { captureId: string; pipeline: Pipeline }): Promise<ActionResult>;
export function requestReview(pool: Pool, input: { id: string }): Promise<ActionResult>;
```
- 语义：
  - `decide`：乐观锁 `WHERE id = $1 AND updated_at = $2 AND deleted_at IS NULL`；设置 `verdict`, `verdict_by='human'`, `verdict_at=now()`, `updated_at=now()`；若由非 keep 变为 keep → 同一事务 `bumpTags`。0 行更新 → 查一次是否存在：不存在 `NOT_FOUND`，否则 `CONFLICT`（message “已在别处处理”）。
  - `editSuggestion`：tags 先 trim/lowercase/dedupe，任何一个 `!isValidTag` → `INVALID`（message 列出不合法标签）；1–6 个；同时设 `verdict='keep'`、human；变为 keep 时 bump 新标签（spec §6「保存即保留」）。
  - `softDelete`：设 `deleted_at=now()`。
  - `requestRerun`：若 capture 为 image 且 `retention.purged_at` 非空 → `OBJECT_GONE`（“原图已过期，无法重跑”）；已有 queued/running run → `CONFLICT`（“已在排队或分析中”）；否则插入新 run（`newId("run")`, state queued, 给定 pipeline）。返回 `updatedAt` 为当前时间 ISO。
  - `requestReview`：`UPDATE … SET review_requested_at = now(), review_error = NULL WHERE id = $1 AND deleted_at IS NULL AND review_requested_at IS NULL`；已在请求中 → `CONFLICT`（“复核已在进行中”）。**不改 updated_at**（它是决定动作的乐观锁）。

- [ ] **Step 1: 迁移**

`lib/db/migrations/003_review_requests.sql`:
```sql
ALTER TABLE caphub_v2.capabilities ADD COLUMN review_requested_at timestamptz;
ALTER TABLE caphub_v2.capabilities ADD COLUMN review_error text;
CREATE INDEX capabilities_review_requested ON caphub_v2.capabilities(review_requested_at) WHERE review_requested_at IS NOT NULL;
```

- [ ] **Step 2: 失败测试**（fake pool/client；按 SQL 前缀分派）

`lib/library/actions.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { decide, editSuggestion, requestReview, requestRerun, softDelete } from "./actions";

type Handler = (text: string, values: unknown[]) => { rows: unknown[]; rowCount?: number };
function fakePool(handler: Handler) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const q = async (text: string, values: unknown[] = []) => { calls.push({ text, values }); const r = handler(text, values); return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length }; };
  return { calls, pool: { query: q, connect: async () => ({ query: q, release() {} }) } as never };
}
const T = "2026-09-19T10:00:00.000Z";

describe("decide", () => {
  it("updates with optimistic lock and bumps tags on transition into keep", async () => {
    const { pool, calls } = fakePool((t) => t.startsWith("UPDATE caphub_v2.capabilities") ? { rows: [{ updated_at: new Date(T), tags: ["python"], previous: "pending" }] } : { rows: [] });
    const r = await decide(pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "keep" });
    expect(r).toEqual({ ok: true, updatedAt: T });
    const upd = calls.find((c) => c.text.startsWith("UPDATE caphub_v2.capabilities"))!;
    expect(upd.text).toMatch(/updated_at = \$2/);
    expect(upd.text).toMatch(/verdict_by = 'human'/);
    expect(calls.some((c) => c.text.includes("INSERT INTO caphub_v2.tags"))).toBe(true);
  });
  it("does not bump tags when discarding", async () => {
    const { pool, calls } = fakePool((t) => t.startsWith("UPDATE caphub_v2.capabilities") ? { rows: [{ updated_at: new Date(T), tags: ["python"], previous: "pending" }] } : { rows: [] });
    await decide(pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "discard" });
    expect(calls.some((c) => c.text.includes("INSERT INTO caphub_v2.tags"))).toBe(false);
  });
  it("returns CONFLICT when the row changed and NOT_FOUND when missing", async () => {
    const conflict = fakePool((t) => t.startsWith("SELECT 1") ? { rows: [{ "?column?": 1 }] } : { rows: [] });
    expect(await decide(conflict.pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "keep" })).toMatchObject({ ok: false, reason: "CONFLICT", message: "已在别处处理" });
    const missing = fakePool(() => ({ rows: [] }));
    expect(await decide(missing.pool, { id: "cab_1", expectedUpdatedAt: T, verdict: "keep" })).toMatchObject({ ok: false, reason: "NOT_FOUND" });
  });
});

describe("editSuggestion", () => {
  it("rejects invalid tags", async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    const r = await editSuggestion(pool, { id: "cab_1", expectedUpdatedAt: T, type: "skill", usage: "integrate", tags: ["Web Scraping", "爬虫"] });
    expect(r).toMatchObject({ ok: false, reason: "INVALID" });
  });
  it("saves normalised tags and keeps", async () => {
    const { pool, calls } = fakePool((t) => t.startsWith("UPDATE caphub_v2.capabilities") ? { rows: [{ updated_at: new Date(T), tags: ["web-scraping"], previous: "pending" }] } : { rows: [] });
    await editSuggestion(pool, { id: "cab_1", expectedUpdatedAt: T, type: "skill", usage: "integrate", tags: [" Web-Scraping ", "web-scraping"] });
    const upd = calls.find((c) => c.text.startsWith("UPDATE caphub_v2.capabilities"))!;
    expect(upd.values).toContainEqual(["web-scraping"]);
    expect(upd.text).toMatch(/verdict = 'keep'/);
  });
});

describe("softDelete / requestReview / requestRerun", () => {
  it("soft deletes with lock", async () => {
    const { pool, calls } = fakePool((t) => t.startsWith("UPDATE") ? { rows: [{ updated_at: new Date(T) }] } : { rows: [] });
    expect(await softDelete(pool, { id: "cab_1", expectedUpdatedAt: T })).toMatchObject({ ok: true });
    expect(calls[0].text).toMatch(/deleted_at = now\(\)/);
  });
  it("requestReview does not touch updated_at and conflicts when already requested", async () => {
    const ok = fakePool(() => ({ rows: [{ id: "cab_1" }] }));
    await requestReview(ok.pool, { id: "cab_1" });
    expect(ok.calls[0].text).not.toMatch(/updated_at/);
    const busy = fakePool(() => ({ rows: [] }));
    expect(await requestReview(busy.pool, { id: "cab_1" })).toMatchObject({ ok: false, reason: "CONFLICT" });
  });
  it("requestRerun refuses purged images and active runs, else inserts a queued run", async () => {
    const purged = fakePool((t) => t.includes("FROM caphub_v2.captures") ? { rows: [{ kind: "image", purged: true, active: false }] } : { rows: [] });
    expect(await requestRerun(purged.pool, { captureId: "cap_1", pipeline: "mixed" })).toMatchObject({ ok: false, reason: "OBJECT_GONE" });
    const active = fakePool((t) => t.includes("FROM caphub_v2.captures") ? { rows: [{ kind: "text", purged: false, active: true }] } : { rows: [] });
    expect(await requestRerun(active.pool, { captureId: "cap_1", pipeline: "mixed" })).toMatchObject({ ok: false, reason: "CONFLICT" });
    const fresh = fakePool((t) => t.includes("FROM caphub_v2.captures") ? { rows: [{ kind: "text", purged: false, active: false }] } : { rows: [] });
    expect(await requestRerun(fresh.pool, { captureId: "cap_1", pipeline: "mixed" })).toMatchObject({ ok: true });
    expect(fresh.calls.some((c) => c.text.startsWith("INSERT INTO caphub_v2.analysis_runs") && c.values.includes("mixed"))).toBe(true);
  });
});
```

- [ ] **Step 3:** 运行确认失败。

- [ ] **Step 4: 实现** `lib/library/actions.ts`:
```ts
import type { Pool, PoolClient } from "pg";
import { capabilityTypeSchema, isValidTag, type CapabilityType } from "../analysis/card";
import { bumpTags } from "../analysis/tags";
import type { Pipeline } from "../config";
import { newId } from "../ids";

export type ActionResult =
  | { ok: true; updatedAt: string }
  | { ok: false; reason: "CONFLICT" | "NOT_FOUND" | "INVALID" | "OBJECT_GONE"; message: string };

const conflict = (message = "已在别处处理"): ActionResult => ({ ok: false, reason: "CONFLICT", message });
const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

async function tx<T>(pool: Pool, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const r = await fn(db);
    await db.query("COMMIT");
    return r;
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

async function missingOrConflict(db: Pick<Pool, "query">, id: string): Promise<ActionResult> {
  const r = await db.query("SELECT 1 FROM caphub_v2.capabilities WHERE id = $1 AND deleted_at IS NULL", [id]);
  return r.rows.length ? conflict() : { ok: false, reason: "NOT_FOUND", message: "卡片不存在或已删除" };
}

export function decide(pool: Pool, input: { id: string; expectedUpdatedAt: string; verdict: "keep" | "discard" }): Promise<ActionResult> {
  return tx(pool, async (db) => {
    const r = await db.query<{ updated_at: Date; tags: string[]; previous: string }>(
      `UPDATE caphub_v2.capabilities cb SET verdict = $3, verdict_by = 'human', verdict_at = now(), updated_at = now()
       FROM (SELECT verdict AS previous FROM caphub_v2.capabilities WHERE id = $1) prev
       WHERE cb.id = $1 AND cb.updated_at = $2 AND cb.deleted_at IS NULL
       RETURNING cb.updated_at, cb.tags, prev.previous`,
      [input.id, input.expectedUpdatedAt, input.verdict]);
    const row = r.rows[0];
    if (!row) return missingOrConflict(db, input.id);
    if (input.verdict === "keep" && row.previous !== "keep") await bumpTags(db, row.tags);
    return { ok: true, updatedAt: iso(row.updated_at) };
  });
}

export function editSuggestion(pool: Pool, input: { id: string; expectedUpdatedAt: string; type: CapabilityType; usage: "integrate" | "reference"; tags: string[] }): Promise<ActionResult> {
  const tags = [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  const bad = tags.filter((t) => !isValidTag(t));
  if (!capabilityTypeSchema.safeParse(input.type).success || !["integrate", "reference"].includes(input.usage)) {
    return Promise.resolve({ ok: false, reason: "INVALID", message: "类型或用法不合法" });
  }
  if (bad.length || tags.length < 1 || tags.length > 6) {
    return Promise.resolve({ ok: false, reason: "INVALID", message: bad.length ? `标签不合法：${bad.join("、")}（需英文小写，可用连字符）` : "标签需 1–6 个" });
  }
  return tx(pool, async (db) => {
    const r = await db.query<{ updated_at: Date; tags: string[]; previous: string }>(
      `UPDATE caphub_v2.capabilities cb SET type = $3, usage = $4, tags = $5, verdict = 'keep', verdict_by = 'human', verdict_at = now(), updated_at = now()
       FROM (SELECT verdict AS previous FROM caphub_v2.capabilities WHERE id = $1) prev
       WHERE cb.id = $1 AND cb.updated_at = $2 AND cb.deleted_at IS NULL
       RETURNING cb.updated_at, cb.tags, prev.previous`,
      [input.id, input.expectedUpdatedAt, input.type, input.usage, tags]);
    const row = r.rows[0];
    if (!row) return missingOrConflict(db, input.id);
    if (row.previous !== "keep") await bumpTags(db, tags);
    return { ok: true, updatedAt: iso(row.updated_at) };
  });
}

export async function softDelete(pool: Pool, input: { id: string; expectedUpdatedAt: string }): Promise<ActionResult> {
  const r = await pool.query<{ updated_at: Date }>(
    `UPDATE caphub_v2.capabilities SET deleted_at = now(), updated_at = now()
     WHERE id = $1 AND updated_at = $2 AND deleted_at IS NULL RETURNING updated_at`, [input.id, input.expectedUpdatedAt]);
  return r.rows[0] ? { ok: true, updatedAt: iso(r.rows[0].updated_at) } : missingOrConflict(pool, input.id);
}

export async function requestRerun(pool: Pool, input: { captureId: string; pipeline: Pipeline }): Promise<ActionResult> {
  const c = (await pool.query<{ kind: string; purged: boolean; active: boolean }>(
    `SELECT c.kind,
            EXISTS (SELECT 1 FROM caphub_v2.retention t WHERE t.object_key = c.object_key AND t.purged_at IS NOT NULL) AS purged,
            EXISTS (SELECT 1 FROM caphub_v2.analysis_runs r WHERE r.capture_id = c.id AND r.state IN ('queued','running')) AS active
     FROM caphub_v2.captures c WHERE c.id = $1`, [input.captureId])).rows[0];
  if (!c) return { ok: false, reason: "NOT_FOUND", message: "投递记录不存在" };
  if (c.kind === "image" && c.purged) return { ok: false, reason: "OBJECT_GONE", message: "原图已过期，无法重跑" };
  if (c.active) return conflict("已在排队或分析中");
  await pool.query("INSERT INTO caphub_v2.analysis_runs (id, capture_id, pipeline, state) VALUES ($1, $2, $3, 'queued')",
    [newId("run"), input.captureId, input.pipeline]);
  return { ok: true, updatedAt: new Date().toISOString() };
}

export async function requestReview(pool: Pool, input: { id: string }): Promise<ActionResult> {
  const r = await pool.query<{ id: string }>(
    `UPDATE caphub_v2.capabilities SET review_requested_at = now(), review_error = NULL
     WHERE id = $1 AND deleted_at IS NULL AND review_requested_at IS NULL RETURNING id`, [input.id]);
  return r.rows[0] ? { ok: true, updatedAt: new Date().toISOString() } : conflict("复核已在进行中");
}
```
（`fakePool` 的 `SELECT 1` 分派依赖 `missingOrConflict` 的 SQL 以 `SELECT 1` 开头；保持这一点。）

- [ ] **Step 5: Server Actions 薄封装** — 先读 `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md`。

`app/actions.ts`:
```ts
"use server";
import { revalidatePath } from "next/cache";
import type { CapabilityType } from "../lib/analysis/card";
import { decide, editSuggestion, requestRerun, requestReview, softDelete, type ActionResult } from "../lib/library/actions";
import { getRuntime } from "../lib/runtime";

function refresh() { revalidatePath("/", "layout"); }

export async function decideAction(id: string, expectedUpdatedAt: string, verdict: "keep" | "discard"): Promise<ActionResult> {
  const r = await decide(getRuntime().pool, { id, expectedUpdatedAt, verdict }); refresh(); return r;
}
export async function editSuggestionAction(id: string, expectedUpdatedAt: string, type: CapabilityType, usage: "integrate" | "reference", tags: string[]): Promise<ActionResult> {
  const r = await editSuggestion(getRuntime().pool, { id, expectedUpdatedAt, type, usage, tags }); refresh(); return r;
}
export async function softDeleteAction(id: string, expectedUpdatedAt: string): Promise<ActionResult> {
  const r = await softDelete(getRuntime().pool, { id, expectedUpdatedAt }); refresh(); return r;
}
export async function rerunAction(captureId: string): Promise<ActionResult> {
  const { pool, config } = getRuntime();
  const r = await requestRerun(pool, { captureId, pipeline: config.pipeline }); refresh(); return r;
}
export async function reviewAction(id: string): Promise<ActionResult> {
  const r = await requestReview(getRuntime().pool, { id }); refresh(); return r;
}
```
Server Actions 同样经过 `proxy.ts` 的 Access 校验（POST 到页面路径）；在报告里写明你如何确认这一点（读文档 + 查看 proxy matcher）。

- [ ] **Step 6:** `npx vitest run lib/library` → PASS；typecheck、lint、build。
- [ ] **Step 7:** 提交 `feat(library): human actions with optimistic locking and migration 003`。

---

### Task 5: worker 执行复核 + 软删满 30 天硬删

**Files:**
- Create: `lib/worker/reviews.ts`, `lib/worker/reviews.test.ts`
- Modify: `lib/retention/retention.ts`（+ 测试）、`scripts/worker.ts`

**Interfaces:**
- Consumes: `reviewCapability(deps: { pool; call }, capabilityId, signal)`（`lib/analysis/review.ts`）、`createDeepSeekCall({ apiKey })`、`runErrorCode(error)`（`lib/worker/tick.ts`）。
- Produces: `runReviewTick(deps: { pool: Pool; call: StructuredCall; log?: (o: Record<string, unknown>) => void }, signal: AbortSignal): Promise<"idle" | "processed">`；`purgeDeletedCapabilities(pool: Pool, now: Date): Promise<number>`（retention.ts）。

- [ ] **Step 1: 失败测试**

`lib/worker/reviews.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { runReviewTick } from "./reviews";

function fakePool(claimRow: { id: string } | undefined) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const q = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    if (text.includes("FOR UPDATE SKIP LOCKED")) return { rows: claimRow ? [claimRow] : [] };
    return { rows: [] };
  };
  return { calls, pool: { query: q, connect: async () => ({ query: q, release() {} }) } as never };
}
const call = (ok: boolean) => ({ provider: "deepseek", model: "d", invoke: async () => { if (!ok) throw Object.assign(new Error("x"), { code: "TIMEOUT" }); return { value: { agrees: true, points: ["ok"] }, usage: { inputTokens: 1, outputTokens: 1 } }; } });

describe("runReviewTick", () => {
  it("is idle when nothing requested", async () => {
    const { pool } = fakePool(undefined);
    expect(await runReviewTick({ pool, call: call(true), review: async () => ({ agrees: true, points: [] }) }, new AbortController().signal)).toBe("idle");
  });
  it("runs the review and clears the request", async () => {
    const { pool, calls } = fakePool({ id: "cab_1" });
    const seen: string[] = [];
    await runReviewTick({ pool, call: call(true), review: async (_d, id) => { seen.push(id); return { agrees: true, points: [] }; } }, new AbortController().signal);
    expect(seen).toEqual(["cab_1"]);
    expect(calls.some((c) => /review_requested_at = NULL/.test(c.text) && /review_error = NULL/.test(c.text))).toBe(true);
  });
  it("records a readable error and clears the request on failure", async () => {
    const { pool, calls } = fakePool({ id: "cab_1" });
    await runReviewTick({ pool, call: call(true), review: async () => { throw Object.assign(new Error("slow"), { code: "TIMEOUT" }); } }, new AbortController().signal);
    const upd = calls.find((c) => /review_error = \$2/.test(c.text))!;
    expect(upd.values[1]).toBe("TIMEOUT");
  });
});
```
（`review` 依赖注入，默认值为 `reviewCapability`。）

在 `lib/retention/retention.test.ts` 加：
```ts
it("hard-deletes capabilities soft-deleted more than 30 days ago", async () => {
  const calls: string[] = [];
  const pool = { query: async (t: string) => { calls.push(t); return { rows: [], rowCount: 2 }; } } as never;
  expect(await purgeDeletedCapabilities(pool, new Date("2026-10-20T00:00:00Z"))).toBe(2);
  expect(calls[0]).toMatch(/DELETE FROM caphub_v2\.capabilities WHERE deleted_at <= \$1::timestamptz - interval '30 days'/);
});
```

- [ ] **Step 2:** 运行确认失败。

- [ ] **Step 3: 实现**

`lib/worker/reviews.ts`:
```ts
import type { Pool } from "pg";
import { reviewCapability } from "../analysis/review";
import type { ReviewNote } from "../analysis/card";
import type { StructuredCall } from "../analysis/structured";
import { runErrorCode } from "./tick";

export interface ReviewTickDeps {
  pool: Pool;
  call: StructuredCall;
  review?: (deps: { pool: Pool; call: StructuredCall }, id: string, signal: AbortSignal) => Promise<ReviewNote>;
  log?: (o: Record<string, unknown>) => void;
}

export async function runReviewTick(deps: ReviewTickDeps, signal: AbortSignal): Promise<"idle" | "processed"> {
  const claimed = (await deps.pool.query<{ id: string }>(
    `SELECT id FROM caphub_v2.capabilities WHERE review_requested_at IS NOT NULL AND deleted_at IS NULL
     ORDER BY review_requested_at LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
  if (!claimed) return "idle";
  const review = deps.review ?? reviewCapability;
  try {
    await review({ pool: deps.pool, call: deps.call }, claimed.id, signal);
    await deps.pool.query("UPDATE caphub_v2.capabilities SET review_requested_at = NULL, review_error = NULL WHERE id = $1", [claimed.id]);
    deps.log?.({ review: "done", capability: claimed.id });
  } catch (error) {
    const code = runErrorCode(error);
    await deps.pool.query("UPDATE caphub_v2.capabilities SET review_requested_at = NULL, review_error = $2 WHERE id = $1", [claimed.id, code]);
    deps.log?.({ review: "failed", capability: claimed.id, code });
  }
  return "processed";
}
```
说明：`FOR UPDATE SKIP LOCKED` 在自动提交下只锁到语句结束；worker 是单实例单循环，复核串行执行，满足需求（在代码注释里写明这一前提）。

`lib/retention/retention.ts` 追加：
```ts
export async function purgeDeletedCapabilities(pool: Pick<Pool, "query">, now: Date): Promise<number> {
  const r = await pool.query(
    "DELETE FROM caphub_v2.capabilities WHERE deleted_at <= $1::timestamptz - interval '30 days'", [now.toISOString()]);
  return r.rowCount ?? 0;
}
```
（captures 与 runs 保留：capture 仍可去重，run/steps 留作审计；图片仍按 retention 规则 30 天清除。）

`scripts/worker.ts`：
- 建 `const reviewCall = createDeepSeekCall({ apiKey: config.providers.deepseekApiKey });`
- 在 `if (config.analysisEnabled)` 块内，`runTick` 返回 `"idle"` 时再调用 `runReviewTick({ pool, call: reviewCall, log }, controller.signal)`（try/catch，错误写 `reviewTickError` 日志）。
- 每小时清扫的 `.then` 里追加 `purgeDeletedCapabilities(pool, new Date())` 并记日志 `{ purgedCapabilities: n }`。

- [ ] **Step 4:** `npx vitest run lib/worker lib/retention` → PASS；typecheck、lint。
- [ ] **Step 5:** 提交 `feat(worker): execute requested reviews and hard-delete soft-deleted cards after 30 days`。

---

### Task 6: 共享展示组件 + 投递页重做

**Files:**
- Create: `components/capability/verdict-badge.tsx`, `tag-list.tsx`, `capture-preview.tsx`, `card-summary.tsx`, `playbook-view.tsx`, `copy-button.tsx`, `analysis-details.tsx`
- Rewrite: `app/page.tsx`, `app/capture-form.tsx`
- Test: `components/capability/components.test.tsx`（`@testing-library/react` + jsdom；若未安装，`npm i -D @testing-library/react jsdom` 并在 vitest 配置里为 `*.test.tsx` 设 `environment: "jsdom"`）

**Interfaces:**
- Consumes: `CapabilityRow`, `CapabilityDetail`, `StepSummary`（Task 3）、labels（Task 3）、`RecentCapture`（Task 3 扩展后）。
- Produces:
```tsx
<VerdictBadge verdict verdictBy? />               // 保留/丢弃/待决 + “自动”小徽章
<TagList tags />                                  // .tag-list
<CapturePreview capture={{ kind, objectKey, text, url }} size?: "thumb" | "full" />  // image → <img src=`/api/objects/${objectKey}` loading="lazy" alt="投递的截图">；text → 前 140 字；url → 可点击链接
<CardSummary row={CapabilityRow} />               // 六项：标题、类型徽章、建议+理由、摘要、原始输入、标签
<PlaybookView playbook type />                    // integrate: install 命令逐行 <pre> + CopyButton，repo 链接，prompt_text <pre> + CopyButton；reference: 要点 <ol>；experience: content <pre> + when_to_use
<CopyButton text label? />                        // client，navigator.clipboard.writeText，复制后显示“已复制” 1.5s
<AnalysisDetails detail={CapabilityDetail} />     // <details><summary>详情</summary>：每步表（步骤/服务/耗时 s/token/结果）、来源链接列表、技术信息（capture/card/run id、pipeline）
```

- [ ] **Step 1: 失败测试**（渲染断言文本与关键属性）

`components/capability/components.test.tsx`:
```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CardSummary } from "./card-summary";
import { PlaybookView } from "./playbook-view";

const row = {
  id: "cab_1", captureId: "cap_1", title: "Scrapling 自适应爬虫框架", type: "skill", summary: "摘要文字", signals: ["a", "b"],
  suggestedVerdict: "keep", suggestedReason: "成熟开源", confidence: 0.86, verdict: "pending", verdictBy: null,
  usage: "integrate", playbook: { kind: "integrate", install: ["pip install scrapling"], repo: "D4Vinci/Scrapling", prompt_text: null },
  tags: ["web-scraping", "python"], sourceUrl: null, reviewNote: null, reviewRequestedAt: null, reviewError: null,
  syncedAt: null, deletedAt: null, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z",
  capture: { kind: "image", objectKey: "sha256/ab/" + "a".repeat(64), text: null, url: null }
} as const;

describe("CardSummary", () => {
  it("shows the six review fields and no internal ids", () => {
    const { container } = render(<CardSummary row={row as never} />);
    expect(screen.getByText("Scrapling 自适应爬虫框架")).toBeTruthy();
    expect(screen.getByText("技能")).toBeTruthy();
    expect(screen.getByText(/建议保留/)).toBeTruthy();
    expect(screen.getByText("成熟开源", { exact: false })).toBeTruthy();
    expect(screen.getByText("摘要文字")).toBeTruthy();
    expect(screen.getByText("web-scraping")).toBeTruthy();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(`/api/objects/sha256/ab/${"a".repeat(64)}`);
    expect(container.textContent).not.toMatch(/cab_|cap_|run_/);
  });
});

describe("PlaybookView", () => {
  it("renders integrate commands with copy buttons", () => {
    render(<PlaybookView type="skill" playbook={row.playbook as never} />);
    expect(screen.getByText("pip install scrapling")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /复制/ }).length).toBeGreaterThan(0);
  });
  it("renders experience content", () => {
    render(<PlaybookView type="experience" playbook={{ kind: "experience", content: "核心步骤", when_to_use: "生成图片时" }} />);
    expect(screen.getByText("核心步骤")).toBeTruthy();
    expect(screen.getByText(/生成图片时/)).toBeTruthy();
  });
});
```

- [ ] **Step 2:** 运行确认失败。

- [ ] **Step 3: 实现组件。** 要求（实现者按此写，用 Task 1 的 CSS 类，不写内联样式）：
  - `CardSummary`：`<article className="panel review-card">`；头部 `CapturePreview size="thumb"` + 标题 `<h2 className="card-title">` + 行内徽章（类型 `badge--type`、用法 `badge--usage`、`VerdictBadge`）；`<p className="card-suggestion">建议{保留|丢弃} · 置信度 {0.86} — {suggestedReason}</p>`；`<p className="card-summary">{summary}</p>`；`<ul className="card-signals">` 列出 signals；`<TagList>`。在 `globals.css` 追加这些类（`review-card` 为两列：左 thumb 72px，右内容；≤600px 单列），同一提交里写入。
  - `CapturePreview`：image → `<img className="thumb" …>`（`size="full"` 时用 `.capture-full`：`max-width:100%; max-height:560px; object-fit:contain; border-radius; border`）；text → `<blockquote className="capture-text">` 截断 280 字；url → `<a className="capture-url" href target="_blank" rel="noreferrer">`。
  - `PlaybookView` / `CopyButton` / `AnalysisDetails` 按上面的接口说明实现；`AnalysisDetails` 的耗时显示 `(durationMs/1000).toFixed(1) s`，token 为 in+out。
- [ ] **Step 4: 投递页**：`app/page.tsx` 结构：
```tsx
<div className="caphub-page">
  <section className="caphub-intro">
    <div><h1>投递一个能力</h1><p>截图、文字或链接都可以。分析完成后，把握大的会自动保留或丢弃，其余进入 Review。</p></div>
    <Link className="caphub-quiet-button" href="/review">去 Review（{stats.pending}）</Link>
  </section>
  <CaptureForm />
  <section className="recent">
    <div className="caphub-section-heading"><h2>最近投递</h2><span>最近 20 条</span></div>
    {items.length === 0 ? <p className="empty">还没有投递。</p> : <ul className="list">{items.map(item => <li key=…><RecentRow item={item} /></li>)}</ul>}
  </section>
</div>
```
  `RecentRow`（放在 `app/recent-row.tsx`，client 组件，因为有重跑按钮）：左 `CapturePreview thumb`；中：标题 = `item.title ?? (text 前 40 字 | url 主机名 | "截图")`，meta 行 = 状态徽章（排队中/分析中/已建卡/失败）+ 结论徽章（有 capability 时）+ 相对时间（`Intl.RelativeTimeFormat("zh-CN")`）；失败时显示 `errorLabel(errorCode)` 与“重跑”按钮（调用 `rerunAction(item.id)`，结果非 ok 时显示 message）；右：有 capability → `<Link className="btn" href={`/library/${capabilityId}`}>查看</Link>`（deleted 时不显示链接）。
  `capture-form.tsx`：改用 `.caphub-workbench` 两栏结构（左：`.caphub-evidence-panel` 拖拽/粘贴/选择图片的 `.caphub-drop-zone`，保留现有逻辑与“清除图片”；右：`.caphub-context-panel` 里 `.caphub-field` 包 textarea「或粘贴文字 / URL」，`.caphub-submit` 按钮「投递」，pending 时 `.caphub-spinner`）。提交成功后显示 `.notice`：新建 → “已收到，正在排队分析”；重复 → “这张图/这段内容之前投递过，已指向原记录”。
- [ ] **Step 5:** `npm test`、typecheck、lint、build 通过。
- [ ] **Step 6:** 提交 `feat(web): shared capability components and redesigned submit page`。

---

### Task 7: Review 页

**Files:**
- Create: `app/review/page.tsx`, `components/review/review-card.tsx`, `components/review/suggestion-editor.tsx`, `components/review/review-card.test.tsx`

**Interfaces:**
- Consumes: `listPending`, `PAGE_SIZE`（Task 3）、`decideAction`, `editSuggestionAction`（Task 4）、`CardSummary`, `AnalysisDetails`（Task 6）、`getCapabilityDetail`。
- Produces: `<ReviewCard row detail />`（client）。

- [ ] **Step 1: 失败测试**（mock `../../app/actions`，vitest `vi.mock`）
```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../app/actions", () => ({
  decideAction: vi.fn(async () => ({ ok: false, reason: "CONFLICT", message: "已在别处处理" })),
  editSuggestionAction: vi.fn()
}));
import { ReviewCard } from "./review-card";
// row/detail fixtures: reuse the CardSummary fixture shape with steps: [] and sources: []

describe("ReviewCard", () => {
  it("greys out with the conflict message when the decision conflicts", async () => {
    const { container } = render(<ReviewCard row={row} detail={detail} />);
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    await waitFor(() => expect(screen.getByText("已在别处处理")).toBeTruthy());
    expect(container.querySelector("[data-state='stale']")).toBeTruthy();
  });
});
```
（在测试文件里写出与 Task 6 相同的 `row` 常量，并 `const detail = { ...row, steps: [], sources: [], runPipeline: "mixed", runState: "done" }`。）

- [ ] **Step 2:** 运行确认失败。
- [ ] **Step 3: 实现**
  - `ReviewCard`：`<div data-state={state}>`，state ∈ `idle | saving | done | stale`；内含 `CardSummary`、`AnalysisDetails`、操作行：`保留`（`.btn--primary`）、`丢弃`（`.btn--danger`）、`改建议`（展开 `SuggestionEditor`）。成功 → state `done` 并显示“已保留 / 已丢弃”，卡片淡出（CSS `.review-card[data-state=done]{opacity:.55}`）；冲突 → `stale`，置灰（`opacity:.5; pointer-events:none` 仅作用于操作区）并显示 message；其他失败 → `.inline-error`。
  - `SuggestionEditor`：类型 `<select>`（5 个类型中文标签）、用法单选（直接整合/参考自研）、标签输入（逗号或空格分隔，下方提示“英文小写，可用连字符，1–6 个”），“保存并保留”调用 `editSuggestionAction`，INVALID 时显示 message。
  - `app/review/page.tsx`：`dynamic = "force-dynamic"`；读 `searchParams.page`；`page-head`（标题“Review”，副标题“{total} 张待决卡片”）；空态 `.empty`“没有待决的卡片。新投递的内容分析完成后，拿不准的会出现在这里。”；列表每张卡取 `getCapabilityDetail`（20 张以内，逐个查询可接受）；分页链接“上一页 / 下一页”。
- [ ] **Step 4:** `npm test`、typecheck、lint、build。
- [ ] **Step 5:** 提交 `feat(web): review page with keep/discard/edit and conflict handling`。

---

### Task 8: 能力库页

**Files:**
- Create: `app/library/page.tsx`, `app/library/library-filters.tsx`, `lib/library/search-params.ts`, `lib/library/search-params.test.ts`

**Interfaces:**
- Consumes: `listLibrary`, `libraryStats`, `allTags`, `LibraryFilter`（Task 3）、`CapturePreview`, `VerdictBadge`, `TagList`（Task 6）、labels。
- Produces: `parseLibraryParams(sp: Record<string, string | string[] | undefined>): LibraryFilter`；`libraryHref(filter: LibraryFilter, patch: Partial<LibraryFilter>): string`。

- [ ] **Step 1: 失败测试**
```ts
import { describe, expect, it } from "vitest";
import { libraryHref, parseLibraryParams } from "./search-params";

describe("library search params", () => {
  it("parses q, repeated type/tag, usage, discarded, page and drops invalid values", () => {
    const f = parseLibraryParams({ q: " scraping ", type: ["skill", "nope"], tag: ["python", "Bad Tag"], usage: "integrate", discarded: "1", page: "3" });
    expect(f).toEqual({ q: "scraping", types: ["skill"], tags: ["python"], usage: "integrate", discarded: true, page: 3 });
  });
  it("builds hrefs and resets page when filters change", () => {
    const f = parseLibraryParams({ q: "x", page: "4" });
    expect(libraryHref(f, { tags: ["python"] })).toBe("/library?q=x&tag=python");
  });
});
```
- [ ] **Step 2:** 运行确认失败。
- [ ] **Step 3: 实现**
  - `search-params.ts`：用 `capabilityTypeSchema` 与 `isValidTag` 过滤；`libraryHref` 以 `URLSearchParams` 生成，patch 中除 `page` 外的任何字段变化都删除 page。
  - `app/library/page.tsx`：`page-head`（“能力库”，副标题“共 {stats.total} 个能力”）→ `.stat-bar`：每种类型一个 `.stat`（技能/经验/插件/提示词/其他，数字）、“标签” `.stat`、“待 Review” `.stat.stat--accent`（链接到 /review）→ 搜索表单（GET，`input name="q"`，保留其他筛选的 hidden 字段）→ `LibraryFilters`（服务端组件即可：类型 chips、usage chips、“已丢弃”开关，都是 `<Link href={libraryHref(...)}>`，选中态 `aria-current="true"` + `.chip[aria-current=true]` 样式）→ 标签云（前 30 个，点击切换）→ 列表（`.list`，每行 `Link` 到 `/library/{id}`：缩略图、标题、类型/用法徽章、标签、相对时间）→ 空态（有筛选时“没有符合条件的能力。<Link>清除筛选</Link>”，无筛选时“库里还没有保留的能力。”）→ 分页。
  - 在 `globals.css` 追加 `.chip` / `.chip[aria-current="true"]`（与 `.badge--type` 同形，选中为 amber-soft 底 + amber 边）、`.filter-row`（flex wrap gap 8px margin-bottom 12px）、`.search-form`（flex，input 44px 高，同 `.caphub-field input` 样式）。
- [ ] **Step 4:** `npm test`、typecheck、lint、build。
- [ ] **Step 5:** 提交 `feat(web): library page with stats bar, filters and full-text search`。

---

### Task 9: 详情页

**Files:**
- Create: `app/library/[id]/page.tsx`, `app/library/[id]/detail-actions.tsx`, `app/library/[id]/detail-actions.test.tsx`
- Modify: `app/library/[id]/not-found.tsx`（新建）

**Interfaces:**
- Consumes: `getCapabilityDetail`（Task 3）、`decideAction`, `editSuggestionAction`, `softDeleteAction`, `rerunAction`, `reviewAction`（Task 4）、`CardSummary`, `CapturePreview`, `PlaybookView`, `AnalysisDetails`, `SuggestionEditor`（Task 6/7）。

- [ ] **Step 1: 失败测试**（mock actions）
```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const softDeleteAction = vi.fn(async () => ({ ok: true, updatedAt: "2026-09-19T00:00:01.000Z" }));
vi.mock("../../actions", () => ({ softDeleteAction, reviewAction: vi.fn(async () => ({ ok: false, reason: "CONFLICT", message: "复核已在进行中" })), rerunAction: vi.fn(), decideAction: vi.fn(), editSuggestionAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
import { DetailActions } from "./detail-actions";

describe("DetailActions", () => {
  it("asks once before deleting", async () => {
    render(<DetailActions id="cab_1" captureId="cap_1" updatedAt="2026-09-19T00:00:00.000Z" verdict="keep" type="skill" usage="integrate" tags={["python"]} reviewPending={false} />);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(softDeleteAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(softDeleteAction).toHaveBeenCalledOnce());
  });
  it("shows the conflict message for review", async () => {
    render(<DetailActions id="cab_1" captureId="cap_1" updatedAt="t" verdict="keep" type="skill" usage="integrate" tags={[]} reviewPending={false} />);
    fireEvent.click(screen.getByRole("button", { name: "复核" }));
    await waitFor(() => expect(screen.getByText("复核已在进行中")).toBeTruthy());
  });
});
```
- [ ] **Step 2:** 运行确认失败。
- [ ] **Step 3: 实现**
  - `page.tsx`：`params` 为 Promise（Next 16）；无数据或 `deletedAt` 非空 → `notFound()`。布局：面包屑 `<Link href="/library">← 能力库</Link>`；`page-head`（标题 = title；副标题 = 类型 · 用法 · 结论徽章（含“自动/人工”）· 创建时间）；两栏 `.detail-grid`（≤900px 单列）：左 `PlaybookView`（标题“怎么用”）+ 摘要 + signals + 来源链接（sourceUrl）；右 `CapturePreview size="full"` + `DetailActions` + 复核结果区：`reviewRequestedAt` 非空 → `.notice`“DeepSeek 复核中，稍后刷新查看”；`reviewError` → `.inline-error` `复核失败：{errorLabel(reviewError)}`；`reviewNote` → `.panel` “复核意见：同意 / 不同意” + points 列表；最后一行小字“最后同步到 Obsidian：{syncedAt 格式化 | 尚未同步}”。底部 `AnalysisDetails`。
  - `detail-actions.tsx`（client）：按钮组：`改建议`（展开 `SuggestionEditor`）、`复核`（`reviewPending` 时禁用并显示“复核中”）、`重跑分析`、`删除` → 变为“确认删除 / 取消”，确认后 `softDeleteAction` 成功则 `router.push("/library")`；若 `verdict === "pending"` 另显示 `保留` / `丢弃`。所有失败显示 message（`.inline-error`）；成功调用 `router.refresh()`。
  - `globals.css` 追加 `.detail-grid`（grid 7fr/5fr gap 24px；≤900px 1 列）、`.review-note`。
- [ ] **Step 4:** `npm test`、typecheck、lint、build。
- [ ] **Step 5:** 提交 `feat(web): capability detail page with playbook, review, rerun and delete`。

---

### Task 10: 真实库验证、截图与部署

**Files:**
- Create: `scripts/seed-demo.ts`, `scripts/shot.mjs`, `docs/m2-verification.md`, `.agent/screens/m2/*.png`（截图，提交入库）

**说明：** 需要 Human 已授权的临时 Neon branch（M1 同类授权）；主库迁移 003 与部署在本任务末尾执行（已在 M2 授权范围内：推送 main 自动部署）。

- [ ] **Step 1: 种子脚本** `scripts/seed-demo.ts`：在 `DATABASE_URL` 指向的库插入 6 张卡（覆盖 5 种类型；2 张 pending、3 张 keep（含 1 张 experience playbook）、1 张 discard；text/url/image 三种 capture，image 用一个已存在于桶里的 object_key 或留空改为 text），以及对应 run 与 3 个 steps（vision/search/reason，含 search 的 sources）。脚本拒绝在未设置 `SEED_ALLOW=1` 时运行。
- [ ] **Step 2: 临时库验证**（controller 执行）：建临时 branch → `npm run migrate`（应应用 003）→ `SEED_ALLOW=1 npx tsx scripts/seed-demo.ts` → `ACCESS_BYPASS=1 NODE_ENV=development npm run dev` 指向临时库 → 手工路径：投递页列表显示缩略图/标题、无内部 id；Review 页保留一张 → 该卡消失、库统计 +1、该卡标签计数 +1（查 tags 表）；在两个标签页同时对同一卡操作 → 后者显示“已在别处处理”；改建议输入 `Web Scraping` → 显示标签不合法；详情页复核 → 显示“复核中”（`review_requested_at` 已写入，不需要真的跑 worker）；删除 → 回到能力库且该卡消失；能力库搜索 `scraping`、按标签筛选、打开“已丢弃”。每一步把结果写入 `docs/m2-verification.md`。
- [ ] **Step 3: 截图** `scripts/shot.mjs`：用 Playwright（`npm i -D @playwright/test` 并 `npx playwright install chromium`）对 `/`, `/review`, `/library`, `/library/<一张 keep 卡 id>` 在 1440×900 与 390×844（`deviceScaleFactor: 2`, `isMobile: true`）各截一张，存 `.agent/screens/m2/`；同时对 alljobs 本机 `http://127.0.0.1:3456/caphub`（若可访问，否则跳过并说明）截一张 1440 作对照。检查：无横向滚动（`document.documentElement.scrollWidth <= innerWidth`），无内部 id 文本。
- [ ] **Step 4:** 删除临时 branch；在主库执行 `npm run migrate`（应用 003）；推送 main → Railway 自动部署；部署成功后用 `curl` 确认 `https://caphub.agentjoey.ai/` 仍为 302（未登录）且 Railway 域名直连 401。
- [ ] **Step 5:** 提交 `docs(m2): verification record and screenshots`。

---

## Self-review

- **Spec §6 覆盖**：投递页（Task 6，含失败原因 + 重跑）；Review（Task 7：六项、三操作、乐观锁置灰、详情折叠、分页 20）；能力库（Task 8：统计条、筛选、全文检索、已丢弃找回）；详情（Task 9：playbook 三形态、复核、重跑、软删一次确认、synced_at）；“不做”清单未引入。
- **§4**：软删满 30 天硬删（Task 5）；`updated_at` 乐观锁（Task 4）。
- **§5.4**：复核一次 DeepSeek、只写 review_note（Task 5 复用 M1 的 `reviewCapability`）；web 无 key → worker 执行（架构说明）。
- **§5.5**：人工改为 keep 时标签计数（Task 4）。
- **类型一致性**：`ActionResult`、`CapabilityRow`、`CapabilityDetail`、`LibraryFilter` 在 Task 3/4 定义，Task 6–9 只消费；Server Action 名称 `decideAction / editSuggestionAction / softDeleteAction / rerunAction / reviewAction` 在 Task 4 定义，Task 6/7/9 使用。
- **已知取舍**：Review 页对每张卡单独查询详情（≤20 次查询）；个人用量可接受。
- **Telegram（M3）**将直接调用 `lib/library/actions.ts` 的 `decide`。
