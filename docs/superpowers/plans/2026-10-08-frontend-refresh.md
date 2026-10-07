# Frontend Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管线状态可见、Review 以摘要为主并支持键盘处理、能力库改为一张能力一张卡片，并统一动效与样式卫生。

**Architecture:** 纯前端加少量查询字段：`listRecentCaptures` 补当前 run 已成功的步骤，`listLibrary` 在有查询词时补命中来源。客户端新增三个小组件：`PipelineWatcher`（进行中时定时 `router.refresh()`）、`ReviewKeys`（键盘与焦点）、`ThumbImage`（坏图回退）。样式全部留在 `app/globals.css`，不引入任何库。

**Tech Stack:** Next 16.3.3 App Router、React 19.2（`ViewTransition` 来自 `react`）、手写 CSS、Vitest + Testing Library、Playwright 截图脚本 `scripts/shot.mjs`。

**Spec:** `docs/superpowers/specs/2026-10-08-frontend-refresh-proposal.md`，加上 Joey 2026-10-08 的裁定：
1. 能力库每个能力做成一张卡片（卡片网格，替代列表行）。
2. Review 大部分时候看摘要、信任评估结论：卡片默认只显示结论和摘要引子，要点、信号、标签折叠。
3. Review 不做撤销。
4. 能力库的标签云去掉（URL 里的 `tag` 筛选仍然有效，以“已生效筛选”chip 显示）。
5. 全部范围，由 Claude 驱动。

## Global Constraints

- 保留“Paper Workbench”风格，不引入组件库、动效库或图标库（设计规格 `2026-09-19-caphub-v2-design.md:151`）。
- 单一调色板，不加暗色模式，不新增颜色变量值（M3.8 约定：只改字形、形状和颜色的用法）。
- 所有 UI 文案进 `lib/i18n/dict-zh.ts` 和 `dict-en.ts`，两边键一致（`dict.test.ts` 会校验）。
- 新动效必须经过现有的 `prefers-reduced-motion` 全局开关（`globals.css:330`）。
- 粗指针设备的 44px 命中区约定（`globals.css:794-820`）对新增控件同样适用；kbd 提示在粗指针设备上隐藏。
- Mini App（`/mini/*`）共用 `CardSummary` 和 `CapturePreview`，改动必须在 Mini 上同样成立。
- 测试不连真实数据库或模型；视觉验证用临时 Neon branch + `ACCESS_BYPASS=1` 的 `next dev`，在 `localhost` 上进行，用完删除 branch。
- 本计划不涉及迁移。不推送 `main`（推送即部署生产），推送前单独征得 Joey 同意。

## Review Focus

1. 用户正在输入框（改建议的标签输入、搜索框）里打字时按 `Y` / `X`：不得触发保留或丢弃。Task 3 有测试。
2. 带修饰键（⌘ / Ctrl / Alt）的按键，例如 `⌘R` 刷新页面：快捷键必须放行，不拦截。Task 3 有测试。
3. 后台标签页：`PipelineWatcher` 在 `document.hidden` 时不得刷新，回到前台时立即刷新一次。Task 2 有测试。
4. 文字或链接投递（没有“看图”步骤）的阶段进度：不得显示一个永远不亮的“看图”段。Task 2 的 `pipelineStages` 测试覆盖 text、url、YouTube、image 四种。
5. 原图已清除且没有 `thumbKey` 的旧图片投递：列表和卡片都不能出现浏览器坏图框。Task 1 有测试。

---

### Task 1: 样式地基、页头、坏图回退、导航计数

**Files:**
- Modify: `app/globals.css`（动效 token、`.btn` 过渡、硬编码 hover 色、未使用样式、`::selection`、吸顶页头、`.capture-text`、`.kbd`、`.nav-count`）
- Modify: `components/capability/capture-preview.tsx`（新增 `ThumbImage`，thumb 分支用它）
- Test: `components/capability/capture-preview.test.tsx`
- Modify: `lib/library/queries.ts`（新增 `countPending`）
- Modify: `app/(chrome)/layout.tsx`、`components/shell/app-shell.tsx`、`components/shell/primary-nav.tsx`（Review 后显示待处理数）
- Test: `components/shell/primary-nav.test.tsx`

**Interfaces:**
- Produces: `countPending(pool: Q): Promise<number>`；`PrimaryNav` 新增可选 prop `counts?: Partial<Record<"/" | "/review" | "/library", number>>`；CSS token `--dur-1: 120ms`、`--dur-2: 200ms`、`--dur-3: 280ms`、`--ease-out`（等于原 `--ease`，原名保留为别名）、`--ease-pop: cubic-bezier(.2,.9,.3,1.2)`；CSS 类 `.kbd`。

- [ ] **Step 1: 写失败测试**：`CapturePreview` image 类型、`size="thumb"`、只有 `objectKey`（无 `thumbKey`），对 `<img>` 触发 `error` 事件后，渲染 `<span class="thumb">` 且文本为 `dict.noImage`，不再有 `img`。`PrimaryNav` 传 `counts={{ "/review": 3 }}` 时 Review 链接内出现 `3`，计数为 0 时不显示。
- [ ] **Step 2: 跑测试确认失败**：`npx vitest run components/capability/capture-preview.test.tsx components/shell/primary-nav.test.tsx`
- [ ] **Step 3: 实现**
  - `ThumbImage`：`useState(false)`，失败时返回 `<span className={className}>{fallback}</span>`，否则返回带 `onError` 的 `<img>`，并带 `width`/`height` 属性防止跳动。
  - `countPending`：`SELECT count(*)::text AS n FROM caphub_v2.capabilities WHERE verdict = 'pending' AND deleted_at IS NULL`。
  - layout 里 `await countPending(pool)` 传给 `AppShell` → `PrimaryNav`。计数渲染为 `<span className="nav-count">3</span>`，并在链接上加 `aria-label`（“Review，3 条待处理”）。
  - CSS：`.app-header` 改为 `position: sticky; top: 0; background: color-mix(in srgb, var(--paper) 90%, transparent); backdrop-filter: blur(10px)`；`.btn` 改为只过渡 `background-color, border-color, color`，时长 `var(--dur-1)`；`#ffffff` 改为 `var(--paper)` 上的 `--paper-raised` 提亮（`.btn:hover` 用 `background: var(--paper-raised)`，并把 `.btn` 默认底改为 `var(--paper)`）；`#fffdf3`、`#fcebcc` 改为 `color-mix()` 基于现有变量；删除 `.caphub-scope`、`.caphub-notice`、`.caphub-error`、`.caphub-retry-help`、`.caphub-custody__identity` 及其 keyframes（先 grep 确认 TSX 里无引用）；`.capture-text` 去掉左边线，改为整框 `--paper-recessed`；`::selection { background: var(--amber); color: var(--amber-ink) }`；修正 `.review-item` 处“sticky header”注释，使其与现在真正吸顶的页头一致。
- [ ] **Step 4: 跑测试确认通过**，再跑 `npm test`、`npm run typecheck`、`npm run lint`。
- [ ] **Step 5: Commit** `feat(ui): sticky header, motion tokens, thumbnail fallback, review count in nav`

### Task 2: 管线可见

**Files:**
- Create: `lib/captures/stage.ts`，Test: `lib/captures/stage.test.ts`
- Modify: `lib/captures/captures.ts`（`RecentCapture.okSteps`）
- Create: `components/shell/pipeline-watcher.tsx`，Test: `components/shell/pipeline-watcher.test.tsx`
- Modify: `app/(chrome)/recent-row.tsx`、`app/(chrome)/page.tsx`、`app/(chrome)/library/[id]/page.tsx`
- Modify: `lib/i18n/dict-zh.ts`、`dict-en.ts`（`stages` 文案）
- Modify: `app/globals.css`（`.stages`、`.live-dot`、`[data-arrived]`）

**Interfaces:**
- Produces:
  ```ts
  export type Stage = "read" | "watch" | "search" | "reason" | "verdict";
  export interface StageView { stages: Stage[]; current: Stage }
  /** okSteps = 当前 run 中 ok=true 的 step 名去重；kind/url 决定是否有读图或看片阶段。 */
  export function pipelineStages(kind: "image" | "text" | "url", url: string | null, okSteps: readonly string[]): StageView
  ```
  阶段序列：image → `read, search, reason, verdict`；YouTube 链接 → `watch, search, reason, verdict`；其他 text/url → `search, reason, verdict`。`current` 是序列中第一个对应 step 未成功的阶段（`read`/`watch` ↔ `vision`，`search` ↔ `search`，`reason` ↔ `reason`，`verdict` 永远在最后）。
  `PipelineWatcher({ active, intervalMs = 4000 }: { active: boolean; intervalMs?: number })`，不渲染任何内容。
- `RecentCapture` 新增 `okSteps: string[]`（只有 `runState = 'running'` 时非空）。

- [ ] **Step 1: 写失败测试**
  - `stage.test.ts`：image 且 `[]` → current `read`；image 且 `["vision"]` → `search`；text 且 `[]` → stages 不含 `read`，current `search`；YouTube url 且 `["fetch"]` → current `watch`；`["vision","search","reason"]` → `verdict`；失败尝试不算（调用方只传 ok 步骤，这里测“`reason` 不在列表里则停在 reason”）。
  - `pipeline-watcher.test.tsx`（fake timers，mock `next/navigation` 的 `useRouter`）：`active` 时 4 秒后调用一次 `refresh`；`active=false` 不调用；`document.hidden = true` 期间不调用；触发 `visibilitychange` 回到前台立即调用一次；卸载后不再调用。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
  - SQL：在 `listRecentCaptures` 的 lateral 里多取 `id AS run_id`，再加 `LEFT JOIN LATERAL (SELECT coalesce(array_agg(DISTINCT s.step) FILTER (WHERE s.ok), '{}') AS ok_steps FROM caphub_v2.analysis_steps s WHERE s.run_id = r.id AND r.state = 'running') st ON true`，输出 `st.ok_steps AS "okSteps"`。
  - `RecentRow`：`runState` 为 `queued` 时 badge 前加 `.live-dot`；为 `running` 时在 meta 行渲染 `<ol className="stages">`，每段 `data-state="done|current|todo"`，当前段前加 `.live-dot`，整体 `aria-label` 写“分析中：第 2 步，共 4 步，搜索”。用 `useRef` 记住上一次的 `runState`，从 `queued`/`running` 变为 `done` 时设置 `data-arrived`，1.6 秒后清除。
  - 首页：`<PipelineWatcher active={items.some((i) => i.runState === "queued" || i.runState === "running")} />`。
  - 详情页：深度分析排队/进行中，或复核请求未完成时 `active`。
  - CSS：`.live-dot` 6px 琥珀圆点，`caphub-breathe` 1.6s 循环；`.stages` 等宽 12px，段间用 `·`，`done` 为 ink，`current` 为 ink 加粗，`todo` 为 faint；`.list-row[data-arrived]` 用 1.2s 动画把背景从 `--amber-soft` 淡到透明。
- [ ] **Step 4: 跑测试确认通过**，再跑全量测试、typecheck、lint。
- [ ] **Step 5: Commit** `feat(ui): live pipeline stages and auto-refresh while analysis runs`

### Task 3: Review 以摘要为主，键盘处理

**Files:**
- Modify: `components/capability/card-summary.tsx`（结论行突出；要点、信号、标签、原始文字/链接收进“完整摘要”折叠）
- Modify: `components/review/review-card.tsx`（操作按钮移到 `AnalysisDetails` 之前；按钮带 `data-action` 和 kbd 提示；处理完折叠成一行；向外派发事件）
- Create: `components/review/review-keys.tsx`，Test: `components/review/review-keys.test.tsx`
- Modify: `app/(chrome)/review/page.tsx`（挂载 `ReviewKeys`，页头显示快捷键提示和剩余数）
- Modify: `components/review/review-card.test.tsx`、Mini 相关测试（如有断言受影响）
- Modify: i18n 两份字典、`app/globals.css`

**Interfaces:**
- Consumes: Task 1 的 `.kbd`、`--dur-3`、`--ease-out`。
- Produces: 每张卡根元素 `.review-item` 带 `tabIndex={-1}` 和 `data-review-item`；操作按钮带 `data-action="keep" | "discard" | "edit" | "rerun"`；处理完成时 `ReviewCard` 派发 `window.dispatchEvent(new CustomEvent("caphub:review-done", { detail: { id } }))`。
  `ReviewKeys({ total, labels }: { total: number; labels: { remaining: string; hint: string } })` 渲染剩余计数（`aria-live="polite"`）和快捷键提示行，并在 `document` 上监听 `keydown`。

- [ ] **Step 1: 写失败测试**（`review-keys.test.tsx`，渲染两张假卡片的 DOM，各带 `data-action` 按钮和点击 spy）
  - `j` 把焦点移到第一张；再按 `j` 到第二张；`k` 回到第一张。
  - 焦点在第一张时按 `y` 点击它的 keep 按钮；`x` 点击 discard；`e` 点击 edit；`r` 点击 rerun。
  - 焦点在 `<input>` 里按 `y`：不点击。
  - 按 `⌘R`、`Ctrl+Y`：不点击、不 `preventDefault`。
  - 按钮 `disabled` 时按 `y`：不点击。
  - 派发 `caphub:review-done` 后：剩余数减一，焦点移到下一张 `data-state="idle"` 的卡片。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
  - `ReviewKeys`：当前卡 = `document.activeElement?.closest("[data-review-item]")`，没有就取第一张 `data-state="idle"` 的卡。`j`/`k` 在 `[data-review-item][data-state="idle"]` 列表里移动并 `focus()` + `scrollIntoView({ block: "nearest" })`（减少动态时不平滑）。`y/x/e/r` 映射到 `keep/discard/edit/rerun`，找当前卡内 `button[data-action=…]:not(:disabled)` 并 `click()`。跳过条件：`event.metaKey || event.ctrlKey || event.altKey`，或目标是 `input/textarea/select/[contenteditable]`。
  - `CardSummary`：标题、徽章、结论行（建议保留或丢弃、置信度、理由，字号上调一级，作为卡片第二显眼的元素），然后是 `PromptNotice`，然后是摘要引子（prose lead）。之后是 `<details className="card-more">`：summary 写“完整摘要 · N 条要点”，内含要点、信号、原始文字或链接、标签。没有要点、信号、原文和标签时不渲染折叠。
  - `ReviewCard`：顺序改为 `CardSummary` → 操作按钮 → 消息 → `SuggestionEditor` → `AnalysisDetails`。卡片主体包进 `.review-item__fold > div`；`data-state="done"` 时 `grid-template-rows: 0fr` 折叠，只剩 `.review-item__done`（“已保留 · 标题”）。按钮文字后加 `<kbd className="kbd" aria-hidden="true">Y</kbd>`，并用 `aria-keyshortcuts="Y"`。
  - 焦点卡样式：`.review-item:focus-visible, .review-item:focus-within > .review-item__fold .panel` 用 1px ink 描边（墨线强调，不加色）。
- [ ] **Step 4: 跑测试确认通过**（含既有 `review-card.test.tsx`、Mini 测试），再跑全量测试、typecheck、lint。
- [ ] **Step 5: Commit** `feat(review): summary-first cards and keyboard triage`

### Task 4: 能力库卡片网格与降噪

**Files:**
- Create: `components/library/capability-card.tsx`，Test: `components/library/capability-card.test.tsx`
- Modify: `components/capability/capture-preview.tsx`（新增 `size="card"`）
- Modify: `app/(chrome)/library/page.tsx`、`app/(chrome)/library/library-filters.tsx`
- Create: `app/(chrome)/library/active-filters.tsx`，Test: `app/(chrome)/library/active-filters.test.tsx`
- Modify: `lib/library/queries.ts`（`matchedBy`），Test: `lib/library/queries.test.ts`
- Modify: i18n 两份字典、`app/globals.css`（删除 `.stat-bar`/`.stat` 中不再使用的部分、`.tag-row`，新增 `.cap-grid`、`.cap-card`、`.type-bar`、`.filter-panel`、`.active-filters`、`.match-tags`）

**Interfaces:**
- Produces:
  - `CapabilityRow` 新增可选 `matchedBy?: Array<"title" | "text" | "semantic" | "scenario">`，只在有非编号查询词时由 `listLibrary` 填充。
  - `CapabilityCard({ row, locale }: { row: CapabilityRow; locale: Locale })`：整张卡是一个指向 `/library/{id}` 的链接；媒体区（`CapturePreview size="card"`）在上，标题加编号、摘要引子（3 行截断）、徽章行（类型、评分、用途或进度、状态、深挖）、3 个安静标签、相对时间在下；有 `matchedBy` 时在底部显示“命中：标题 · 语义”。
  - `ActiveFilters({ filter, scenarios, locale })`：对 `tags`、`scenarios`、`usage`、`progress`、`discarded`、`includeRetired`、`deepAnalyzed` 每一项渲染一个“标签 ×”链接（去掉该项的 href），超过 1 项时加“清除全部”。没有生效项时不渲染。类型筛选不在这里（类型条本身显示选中态）。

- [ ] **Step 1: 写失败测试**
  - `queries.test.ts`：带 `q="agent"` 调 `listLibrary` 时，生成的 SELECT 含 `AS "matchedBy"`；编号查询（`q="SKL-0003"`）和无查询词时不含。
  - `capability-card.test.tsx`：渲染标题、编号、摘要引子、评分徽章；`matchedBy=["title","semantic"]` 时出现“命中”行和两个中文标签；`status="deprecated"` 时卡片带 `data-muted`；没有图片的 text 投递渲染占位块而不是 `<img>`。
  - `active-filters.test.tsx`：`{ tags:["mcp"], usage:"reference" }` 渲染两个 chip，`mcp ×` 的 href 不含 `tag=mcp` 但保留 `usage=reference`；有两项以上时出现“清除全部”指向 `/library`；空筛选不渲染。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
  - `matchedBy` SQL（复用已有参数下标）：`array_remove(ARRAY[CASE WHEN cb.title ILIKE $ilike THEN 'title' END, CASE WHEN ${ftsMatch} OR cb.summary ILIKE $ilike OR cb.summary_points::text ILIKE $ilike OR cb.build_notes::text ILIKE $ilike OR EXISTS (SELECT 1 FROM unnest(cb.tags) tg WHERE tg ILIKE $ilike) THEN 'text' END, CASE WHEN ${semanticCandidate} THEN 'semantic' END, CASE WHEN ${scenarioMatch} THEN 'scenario' END], NULL) AS "matchedBy"`，通过 `paged` 的 `extra.columns` 传入，`join` 为空串。
  - 页面结构：页头左边标题和副标题，右边两个链接“待 Review N”（琥珀药丸）和“待自研 N”（描边药丸，选中时墨色实底）；搜索框；类型条（`全部 N` 加计数大于 0 或已选中的类型，多选切换，选中为墨色实底）；`<details className="filter-panel">`，summary 写“筛选”并在有生效项时附计数，内含用途/已丢弃/已退役/已深挖、进度、场景三组；`ActiveFilters`；有查询词且 `matchedScenarioSlugs` 非空时显示一行“相关场景”chip；然后是结果数（“共 N 张”）和卡片网格；分页。删除标签云和标签总数块，`allTags` 不再在此页调用（Mini 仍在用，函数保留）。
  - 选中态从琥珀改为墨色实底配纸色文字（`.chip[aria-current="true"]`），让琥珀只留给“待 Review”和高分徽章。`ScoreBadge`：分数 ≥ 4 用现在的琥珀实底，其余用描边（`badge--score-quiet`）。
  - `.cap-grid`：`grid-template-columns: repeat(auto-fill, minmax(264px, 1fr)); gap: var(--space-4)`。`.cap-card`：`--paper-raised` 底、1px `--hairline` 边、`--radius-lg`；hover 时边框变 ink（墨线强调，`--dur-1`），不位移。媒体区高 148px、`object-fit: cover`、底边一条 hairline；占位块用 `--paper-recessed` 和斜线底纹（复用拖放区的纹理），中间等宽字写类型。≤ 600px 时媒体区高 132px。
- [ ] **Step 4: 跑测试确认通过**，再跑全量测试、typecheck、lint。
- [ ] **Step 5: Commit** `feat(library): capability card grid, collapsed filters, search match reasons`

### Task 5: 动效收口

**Files:**
- Modify: `components/library/capability-card.tsx`、`app/(chrome)/library/[id]/page.tsx`（`ViewTransition` 共享元素：卡片标题 ↔ 详情标题，`name={`cap-title-${id}`}`）
- Modify: `components/shell/primary-nav.tsx`（下划线滑动：用一个绝对定位的指示条，按当前项的 `offsetLeft/offsetWidth` 设置 `transform` 和 `width`）
- Modify: `app/(chrome)/capture-form.tsx`（`dragActive` 状态：`onDragEnter`/`onDragLeave`/`onDrop` 维护计数，设置 `data-drag="true"`，提示文案换成“松手投递”）
- Modify: `components/capability/copy-button.tsx`（成功态加 `data-copied`，CSS 用 `--ease-pop` 做一次 scale 0.96 → 1）
- Modify: `app/globals.css`、i18n 两份字典
- Test: `app/(chrome)/capture-form` 既有测试补一条：`dragenter` 后拖放区带 `data-drag="true"` 且出现“松手投递”，`dragleave` 后恢复。

- [ ] **Step 1: 写失败测试**（拖放态）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**。先读 `node_modules/next/dist/docs/01-app/02-guides/view-transitions.md` 的共享元素一节，按其写法使用 `<ViewTransition name=…>`。拖放态 CSS：`.caphub-drop-zone[data-drag="true"] { border: 1px solid var(--ink); box-shadow: 4px 4px 0 var(--ink); background-color: var(--paper-raised) }`，过渡 `--dur-2`。导航指示条过渡 `transform var(--dur-3) var(--ease-out), width var(--dur-3) var(--ease-out)`，首帧不做动画（无前一位置时直接就位）。
- [ ] **Step 4: 跑测试确认通过**，再跑全量测试、typecheck、lint。
- [ ] **Step 5: Commit** `feat(ui): shared-element title transition, nav indicator, drag-over state`

### Task 6: 端到端验证与收尾

- [ ] **Step 1:** 用 Neon MCP 建临时 branch（从生产库的父 branch 分出，名字 `ui-refresh-2026-10-08`），拿 owner 连接串，`npm run migrate`，`SEED_ALLOW=1 npm exec tsx scripts/seed-demo.ts`（若父 branch 已有数据则跳过 seed）。连接串只经环境变量传入，不打印、不落盘。
- [ ] **Step 2:** `ACCESS_BYPASS=1 PORT=3100 next dev`（后台运行，记录停止方法），`node scripts/shot.mjs http://localhost:3100 .agent/screens/ui-refresh / /review /library "/library?q=agent" /library/<id> /mini /mini/review`；检查脚本的横向溢出和内部 id 泄漏结果。
- [ ] **Step 3:** 浏览器走真实路径：键盘处理 Review（J/K/Y/X，输入框内按键不触发）；能力库筛选折叠、生效 chip 移除、搜索命中原因；列表进详情的标题过渡；首页拖拽悬停态；开启减少动态后再看一遍首页和 Review。管线进度需要一条 `running` 的 run：在临时 branch 上手工插入一条 `analysis_runs`（state=running）和一条 ok 的 `vision` 步骤，确认首页显示第 2 步“搜索”，再把 run 改成 done，确认 4 秒内自动刷新并出现到达高亮。
- [ ] **Step 4:** `node <impeccable>/scripts/detect.mjs --json app components`，处理新增发现。
- [ ] **Step 5:** 独立评审：派一个 reviewer 子 agent 看整个分支的改动（重点：键盘事件拦截范围、轮询的启停与内存泄漏、SQL 参数下标、Mini 回归）。修复后重跑受影响检查。
- [ ] **Step 6:** 停 dev server，删除临时 Neon branch（删除前向 Joey 确认），写 `docs/ui-refresh-verification.md`，Commit。推送 `main` 前征得 Joey 同意。
