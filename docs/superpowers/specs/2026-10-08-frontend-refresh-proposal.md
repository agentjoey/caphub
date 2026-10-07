# Caphub 前端优化方案：以 munderdiffl.in 为参照

日期：2026-10-08 · 状态：提案，待 Joey 选定范围

## 0. 结论先行

munderdiffl.in 和 caphub 底子相近：暖纸底色、一个琥珀/橙色强调色、等宽字体做标签、深墨色文字。所以不需要换视觉，参考站值得借的是三件事：

1. **让“在干活”始终看得见。** 参考站每处都在显示代理的状态：`● working`、`on it`、`tests green`、交接气泡。caphub 的核心体验恰好是异步管线（投递 → 看图 → 搜索 → 分析 → 裁决），但现在要手动刷新才能看到结果。这是最大的差距。
2. **强调靠墨线，不靠加色。** 参考站把当前或推荐的元素标成 1px 墨色描边加上浮 8px，偶尔再加一道硬投影 `5px 5px 0 ink`。颜色始终只有一个橙色。caphub 的筛选区和 Review 卡片正缺这种克制的强调方式。
3. **动效按位置分级。** 按钮只在 0.12s 内变背景和边框色，没有回弹。带回弹的曲线只用在小而好玩的部件上，比如环形菜单的错峰展开。每个大动效都处理了 `prefers-reduced-motion`，并在窄屏上关闭。

不该照搬的：像素小人、万圣节主题、跟随滚动的“上班时钟”、标题遮罩上滑和扫光、自动打字演示、滚动渐显。它们服务的是营销落地页（说服），caphub 是 Joey 每天打开几十次的工具（操作）。同一个动效看到第 50 次就成了噪音。

---

## 1. 参考站拆解（实测值）

### 1.1 视觉系统

| 项 | 值 | 备注 |
|---|---|---|
| 底色 | `--paper #FBF4EA`，`--paper-2 #F4E8DA`，`--card #FFFCF7` | 三层纸色，分区靠底色差异而不是线 |
| 文字 | `--ink #1F1628`，`--muted #5B4F63`，`--faint #8C8093` | 墨色略带紫 |
| 强调 | `--accent #F59A3C`，hover `#FFB067`，`--accent-soft rgba(245,154,60,.18)` | 全站只有一个强调色 |
| 语义色 | `--green #2E7D4F`（✓ 列表），`--sky #9A77D0`（焦点、选中） | 焦点色和强调色分开 |
| 字体 | Inter 100–900（变量字重），JetBrains Mono，自制 Pixel 字体 | 导航链接、kicker、tier 名都用等宽 |
| 圆角 | 14 / 10 / 999 | |
| 版心 | `--maxw 1120px`，`--pad 24px` | |
| 标题 | `font-weight 900; letter-spacing -0.05em; line-height .94; clamp(2.9rem, 8.4vw, 6.4rem)` | |
| 焦点 | `:focus-visible { outline: 3px solid ink; outline-offset: 3px }` | |
| 选中文字 | `::selection { background: accent; color: accent-ink }` | 很小的品牌细节 |

**强调的写法：**
- `.tier.hot`：用 1px ink 描边并上浮 8px，背景色不变。
- `.dayclock` 和 `.daynote`：1px ink 描边，配卡片底色。
- 少数主角元素：硬投影 `5px 5px 0 var(--ink)` 或 `8px 8px 0 var(--ink)`。整页只出现两处。
- 其余卡片：`1px solid var(--line)`，没有阴影。

### 1.2 动效清单

| 部件 | 做法 | 曲线 / 时长 |
|---|---|---|
| 按钮 | 只变 background 和 border-color | `0.12s`，没有位移 |
| 主标题 | 每个词放在 `clip-path` 容器里，从 `translateY(105%)` 升到原位，之后用 `background-clip:text` 做一次扫光，按词错峰 0.3、0.42、0.58s | `0.9s cubic-bezier(.2,.9,.1,1)`；≤720px 和减少动态时关闭；无 JS 时直接显示 |
| 区块入场 `[data-rv]` | IntersectionObserver 加 `.in`：`opacity 0→1; translateY(26px)→0` | `0.7s cubic-bezier(.2,.8,.2,1)` |
| 环形菜单 | 子按钮按 `calc(var(--i) * 18ms)` 错峰弹出 | `180ms cubic-bezier(.2,.9,.25,1.2)`，轻回弹 |
| 汉堡按钮 | 三条线变成 ×（translate 加 rotate） | `0.18s` |
| 像素角色 | 呼吸、眨眼、走路，用 `steps(n)` 逐帧 | 循环 |
| 滚动叙事 | 左下角固定时钟随滚动从 9:00 AM 走到 5:00 PM，并显示章节名（Standup、Lunch meeting、Clocking out）；页面底色从纸色渐变到淡紫再到夜色 | ≤640px 隐藏 |

曲线只有几族：`ease` 系列处理颜色变化，`(.2,.8,.2,1)` 处理入场，`(.2,.9,.3,1.2~1.4)` 处理小部件回弹，`steps()` 处理像素动画。

### 1.3 交互模式

- **Memory 搜索演示。** 搜索框自动打出 “why did signup break?”，结果分三栏：WHO WORKED ON IT / TICKETS / MEMORIES。同一个问题，按“人、事、知识”三个维度一次回答。
- **代理列表。** 每行是头像、名字、等宽小字写的“提供方 · 任务编号 + 任务名”，右侧 `● working`。正在交接的两行之间浮出墨色气泡（“Oscar, review acm-4”），当前行用 accent-soft 底色标出。
- **Stapler 特性列表。** 滚动时当前条目高亮，用 accent-soft 底色加墨线描边，其余条目是白卡。
- **状态小片。** Tickets 里用 `Done` / `Doing` 这类等宽小药丸；快捷键写成 `⇧ ⌘ N` 的 kbd 样式（1px ink 边、6px 圆角、等宽）。
- **FAQ。** 原生 `<details>`，summary 右侧是等宽的 `+` / `×`。
- **价格。** 推荐档用墨线描边并上浮，其余两档平放。

### 1.4 移动端

- 标题动效和日钟在窄屏关闭。
- 两个主按钮改成两列 grid，同宽。
- 导航收进汉堡菜单，抽屉是等宽链接列表。

---

## 2. caphub 现状对照

依据：后台 agent 梳理的前端结构、`.agent/screens/youtube-video/*`（2026-09-22）和 `m2_5/after/home-1440.png` 截图，以及源码。线上站点在 Cloudflare Access 后面，这次没有登录看实时页面，所以 9-24 和 9-27 两轮审计之后的视觉变化没有核对到。

**已经做对、应当保留的：**
- 纸色、墨色加单一琥珀的配色（`app/globals.css:10-82`），和参考站同一路数，而且更克制。
- 等宽字体用于 badge、tag、序列号和 kicker，和参考站的用法一致。
- 投递按钮的文案随状态变化（`capture-form.tsx:95-99`）；复制按钮通过 live region 播报结果；粗指针设备的 44px 命中区。这些都比参考站更细。
- 单一调色板，不做暗色模式（`mini.css:1-7`），这是有意的决定。

**差距（按影响排序）：**

| # | 问题 | 证据 | 严重度 |
|---|---|---|---|
| G1 | 管线状态不可见：投递后只能“稍后刷新”，没有轮询，也没有阶段进度 | 全仓没有 `setInterval` 或 `EventSource`；`router.refresh()` 只在写操作后调用 | P1 |
| G2 | 能力库筛选区信息墙：同屏 10 个统计块、5 个状态 chip、约 20 个场景 chip、30 个标签 chip | `library-1440.png`；`library/page.tsx` | P1 |
| G3 | Review 是长文本墙，操作按钮在每张卡的最底部，没有键盘快捷键，没有队列进度，处理完一张也不会自动聚焦下一张 | `review-1440.png`；全仓没有 `keydown` | P1 |
| G4 | 能力库列表的缩略图坏图：原图已过 30 天清除、又没有 `thumbKey` 的旧投递，会显示浏览器的坏图框和 alt 文字“投递的截图” | `library-1440.png` 中一半的行；`capture-preview.tsx:53-57` 的 thumb 分支没有 `onError` 回退（full 分支有） | P1 |
| G5 | 几乎没有状态过渡：Review 卡处理完直接变成 0.55 不透明度；新投递出现在列表里没有任何提示 | `globals.css:568-575` | P2 |
| G6 | 页头不吸顶，但注释写着 sticky | `globals.css:565`；`app-shell.tsx` | P2 |
| G7 | 强调手段只有琥珀色：选中的 chip、待 Review 块、主按钮、评分徽章全是琥珀，同屏琥珀块太多，强调反而失效 | `library-1440.png` 的筛选区 | P2 |
| G8 | 卫生：`.btn` 用了 `transition: all`；hover 色硬编码 `#ffffff`、`#fffdf3`、`#fcebcc`；有未使用的 CSS（`caphub-custody-in`、`.caphub-notice`、`.caphub-scope`、`.caphub-error`、`.caphub-retry-help`） | `globals.css:280`、`:474`、`:482`、`:391-398` | P3 |

**检测器结果（`detect.mjs`）：** 共 3 条。
- 2 条 side-tab：`globals.css:556` 的 `.capture-text` 和 `:686` 的 `.prompt-block`。`prompt-block` 的左侧琥珀线是引用块惯例，可以保留；`capture-text` 可以改成整框淡底。属于 P3。
- 1 条 broken-image：`capture-preview.tsx:28`。这条是误报，那里已有 `onError` 回退。真正会坏图的是 thumb 分支（G4），检测器没有报出来。

---

## 3. 方案

每一项写明借鉴来源、caphub 的做法、改哪些文件、怎么验收。约束沿用规格 `2026-09-19-caphub-v2-design.md:151`：保留“Paper Workbench”风格，不引入组件库或动效库；Mini App 同步考虑。

### A. 管线可见（P1，对应 G1、G5）

**借鉴：** 代理列表的 `● working`、交接气泡、Tickets 的 Doing/Done 状态片。

**做法：**
1. **自动刷新。** 首页“最近投递”有 `queued` 或 `running` 的行时，每 4 秒调用一次 `router.refresh()`。没有进行中的行就停止；页面隐藏（`visibilitychange`）时暂停。做成一个很小的客户端组件 `<PipelineWatcher active={hasInflight} />`，不需要 SSE。
2. **阶段进度。** 运行中的行显示四段等宽进度：`看图 · 搜索 · 分析 · 裁决`。已完成的段用墨色，当前段前面加呼吸圆点（复用 `caphub-breathe`），未开始的段用 faint 色。数据取当前 run 在 `analysis_steps` 里最新的 step（`lib/analysis/steps.ts:16` 每步写一行）。需要先确认 step 是在每步结束时写入，而不是整个 run 结束后批量写入。如果是批量写入，这一条先退化为只显示“分析中”加呼吸点。
3. **到达提示。** 某行从 `running` 变成 `done` 时，背景从 `--amber-soft` 用 1.2s 淡回透明，同时 badge 换成“已建卡 / 待决”。完全不用位移。
4. **全局计数。** 导航“Review”后面加一个等宽计数 `Review 3`。有进行中的分析时，品牌标记旁加一个小呼吸点，悬停显示“2 条分析中”。这对应参考站固定时钟的作用，但只报有用的信息。

**文件：** `app/(chrome)/page.tsx`、`recent-row.tsx`、新增 `components/shell/pipeline-watcher.tsx`、`components/shell/nav.ts`、`lib/captures/captures.ts`（查询补上当前 step）、`globals.css`。

**验收：** 本地 `localhost` 投递一张图后不刷新页面，能依次看到阶段推进并在完成时看到淡出提示；切到别的标签页时请求停止；开启减少动态后没有呼吸动画，只保留文字状态。

### B. Review 处理流（P1，对应 G3）

**借鉴：** kbd 样式的快捷键、当前项高亮、推荐项上浮描边。

**做法：**
1. **快捷键。** `J` / `K` 切换焦点卡，`Y` 保留，`X` 丢弃，`E` 改建议，`R` 重跑，`?` 打开快捷键面板。焦点在输入框里时全部失效。按钮上用 kbd 小片标出快捷键，粗指针设备上隐藏。
2. **焦点卡。** 焦点卡用 1px ink 描边，非焦点卡保持 hairline 描边。焦点卡的操作条吸附在视口底部（`position: sticky; bottom`），不用滚过整张卡去找按钮。
3. **进度与撤销。** 页头显示 `3 / 6`。保留或丢弃后，卡片用 `grid-template-rows: 1fr → 0fr` 折叠（250ms），焦点移到下一张，底部出现 5 秒的“已保留 · 撤销”条。撤销需要后端支持把裁决改回去；如果暂时不做，就去掉撤销，只保留折叠。
4. **文本墙。** 卡片默认只显示标题、定位一句话和 3 条要点，其余内容放进现有的“详情”折叠里。是否这样做取决于 Joey 的审核习惯是“先读全文再决定”还是“看摘要就决定”。

**文件：** `components/review/review-card.tsx`、`app/(chrome)/review/page.tsx`、新增 `components/review/review-keys.tsx`、`globals.css`、`lib/i18n/dict-*.ts`。

**验收：** 只用键盘处理完 6 张卡；在输入框里按 `Y` 不会触发保留；屏幕阅读器能播报“已保留，剩余 5 张”。

### C. 能力库降噪与搜索解释（P1，对应 G2、G7）

**借鉴：** Memory 演示把一个问题拆成“人 / 事 / 知识”三栏回答；参考站每屏可选项都不超过 6 个。

**做法：**
1. **统计块改成一行类型分段条。** 7 个类型连同计数放进一个 `.segmented`；“待 Review”和“待研究”移到页头右侧，作为两个链接；标签总数直接删掉，它不构成一个操作。
2. **折叠筛选。** 状态、场景、标签三组放进“筛选”折叠区，默认收起。已生效的筛选在搜索框下面排成一行可移除的 chip（`场景: 设计 ×`），外加“清除全部”。
3. **搜索命中原因。** 有查询词时，结果上方先显示一行“相关场景 / 相关标签”，可直接点击进一步缩小范围。每条结果右侧用等宽小字标出命中来源：`标题`、`语义`、`场景`。后端本来就是全文、向量、场景三路合并，只需要把来源字段透传出来。
4. **琥珀只留给“要你处理”的东西。** 选中的筛选改用墨色实底配纸色文字（参考站选中态用的是另一个颜色 `--sky`，caphub 坚持单一调色板，所以用墨色代替）。评分徽章改成描边样式，只有 ≥4/5 时用实底。这样“待 Review”的琥珀色重新显眼。

**文件：** `app/(chrome)/library/page.tsx`、`library-filters.tsx`、`lib/library/queries.ts`（透传命中来源）、`components/capability/score-badge.tsx`、`globals.css`。注意 M3.8 计划里“只改字形和形状、不动颜色变量”的约定：第 4 条只调整颜色的使用方式，不改动任何变量。

**验收：** 1440 宽首屏不滚动就能看到至少 6 条结果（现在约 1 条）；搜一个词后能看出每条结果为什么被命中。

### D. 缩略图回退（P1，对应 G4，可以单独先修）

thumb 分支加上 `onError` 回退，换成类型占位块：等宽字写类型名，例如 `截图` / `链接` / `文字`，样式和现有的“文字”占位一致。顺便给列表缩略图加 `width`、`height` 属性，避免布局跳动。

**文件：** `components/capability/capture-preview.tsx:53-57`，并补一条测试。

### E. 动效系统（P2，对应 G5、G8）

在 `globals.css` 里加一套 token，取代现在散落的 `0.15s var(--ease)`：

```css
--dur-1: 120ms;  /* 颜色、边框 */
--dur-2: 200ms;  /* 小部件出现、kbd 提示 */
--dur-3: 280ms;  /* 折叠、展开、卡片离场 */
--ease-out: cubic-bezier(.2,.8,.2,1);     /* 已有的 --ease，改名 */
--ease-pop: cubic-bezier(.2,.9,.3,1.2);   /* 只用于 badge 变化、复制成功之类的小部件 */
```

用在这些地方：
- **按钮。** `transition: all` 改为只过渡 `background-color, border-color, color`，时长 `--dur-1`，不加位移。这一条照搬参考站。
- **拖放区。** 拖拽悬停时变成 1px ink 描边，加硬投影 `4px 4px 0 var(--ink)`，文案换成“松手投递”。这是全站唯一使用硬投影的地方，作为投递动作的手感标志。
- **列表到详情。** 用 React `<ViewTransition>` 让缩略图和标题过渡到详情页的对应位置。Next 16 的 App Router 无需配置（`node_modules/next/dist/docs/01-app/02-guides/view-transitions.md`），不支持的浏览器正常跳转、不出动画。
- **导航指示线。** 当前项的琥珀下划线在切换页面时滑动过去，而不是瞬间跳过去。
- **减少动态。** 保留现有的全局开关（`globals.css:330`），新加的动效都要经过它。

明确不做：滚动渐显、标题遮罩上滑、扫光、循环装饰动画。

### F. 页头与卫生（P2/P3，对应 G6、G8）

- 页头改成 `position: sticky; top: 0`，背景用 `color-mix(in srgb, var(--paper) 90%, transparent)` 加 `backdrop-filter: blur(10px)`，底边一条 hairline。做法照搬参考站的 nav。同时修正 `globals.css:565` 的注释。
- 加 `::selection { background: var(--amber); color: var(--amber-ink) }`。
- 硬编码的 hover 色收进 token；删掉 G8 列出的未使用样式。
- 把 `.capture-text` 的左侧线改成整框 `--paper-recessed` 底色，消除一条 side-tab。

---

## 4. 建议顺序

| 阶段 | 内容 | 理由 |
|---|---|---|
| 1 | D 缩略图回退，F 页头与卫生 | 改动小、风险低，修掉看得见的瑕疵 |
| 2 | A 管线可见 | 体验提升最大，也最贴合“投递 → 自动分析”这个产品承诺 |
| 3 | B Review 处理流 | 每天高频使用，键盘流收益最直接 |
| 4 | C 能力库降噪 | 涉及信息架构，需要 Joey 先拍板 |
| 5 | E 动效系统 | 前面几项落地后统一收口 |

每个阶段都按 AGENTS.md 的要求验证：本地 `localhost` 截取 1440 和 390 两种宽度，Mini App 单独过一遍，测试不连真实数据库。

## 5. 需要 Joey 决定的事

1. Review 的阅读习惯：看摘要就决定，还是要先读全文？这决定 B.4 是否折叠正文。
2. Review 是否要“撤销”？需要后端支持裁决回退。
3. 能力库的标签云是否还有人用？如果主要靠搜索，C.2 可以更激进，直接移除标签云。
4. 范围：按上面的顺序全做，还是先做 1 到 2 阶段？
