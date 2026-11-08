# Caphub 主页改为「纸团桌面」设计

2026-11-08。Owner（Joey）在会话中确认了方向：桌上的纸团就是待过目的投递，点开后展开成卡片，保留就收进库，丢弃就揉掉扔走。主页上要有搜索入口。实现交给 codex（经 Pactify）。

参考样稿（一次性，不进仓库）：会话临时目录里的 `caphub-crumple/`，基于 [paper-crumple-demo](https://github.com/item-develop/paper-crumple-demo)（Toi Nagasawa / ITEM Inc.，MIT）。本文自成一体，实现者不需要看样稿。

## 1. 为什么做

- 现在的主页是一个投递表单加一列最近投递，Review 是一长串卡片，都很像模型默认会生成的界面（见 `docs/design/caphub-ui-audit-2026-11-07.md`）。
- 新做法把待处理的投递变成桌上的实物：一个纸团对应一张卡，展开就能读，读完一个动作就处理掉。这个隐喻和 Caphub 的流程一一对应：
  - 新投递从上方落到桌上，分析中的纸团是淡琥珀色；
  - 待裁决的卡是纸团；
  - 保留的卡被抚平，放进库那叠纸；
  - 丢弃的卡被揉起来扔走。
- 判断标准：Joey 打开主页，能一眼看出有几张卡要处理，几秒内就能读完一张并做出裁决。也能从主页直接搜索整个库。

## 2. 目标、非目标、反目标

**目标**

1. `/`（主页）改成桌面场景：桌上的纸团就是要处理的投递，墙面上有搜索框和投递入口，右下角那叠纸代表能力库。
2. 在桌面上完成 Review 的四个动作：保留、丢弃、改建议、重跑分析，并且可以打开详情。和 `/review` 共用同一套 server action 和乐观锁。
3. 分析进度实时反映在桌上：新纸团落下来，分析步骤逐个点亮，完成后纸面换成正式卡片。
4. 没有 WebGL、选了列表视图，或者只用键盘、读屏软件时，都有完整可用的路径。

**非目标**

- 能力库列表页（`/library`）、详情页（`/library/[id]`）和 `/review` 页面的版式不改。`/review` 留作完整列表视图。
- Telegram Mini App 不改。
- 桌面上不做批量操作，不做撤销（`/review` 现在也没有）。

**反目标**（技术上做出来了，但出现这些情况就算失败）

- 动画挡住干活：任何动作都不应该等动画播完才能点下一个。
- 首屏变慢：3D 资源不能拖慢主页的首次可交互，必须先显示可用的 HTML，再加载场景。
- 纸面上的字看不清：桌面端 1440×900 展开后，标题和摘要不小于 15 CSS px，其余文字（建议行、要点、标签、顶行）不小于 13 CSS px；手机端摘要不小于 14 CSS px。
- 设备一直发热：桌面静止时不能持续 60fps 渲染。

## 3. 页面结构

### 3.1 桌面端（宽度 ≥ 700px）

```
┌ app header（现有：Caphub / 导航 / 语言）──────────────────────────────┐
│ ┌ 墙（琥珀色）─────────────────────────────────────────────────────┐ │
│ │        [ 搜能力、标签，或输入编号 SKL-0157            ] [投一张] │ │
│ │                                                                   │ │
│ ├ 桌面（纸色）──────────────────────────────────────────────────────┤ │
│ │    纸团  纸团   纸团（淡琥珀：分析中）   纸团                        │ │
│ │  纸团   纸团  纸团       纸团                       ┌库那叠纸┐     │ │
│ │                                                    │最新一张│     │ │
│ │ 桌上 7 张要看 · 还有 3 张在 Review →                 └────────┘     │ │
│ │ 点纸团展开；按住可以拖开，甩一下扔出去             库里 154 张      │ │
│ └───────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

- 场景占满页头以下的视口：高度为 `100dvh` 减页头，不滚动。
- 墙在上，约占 45%；桌面在下，摄像机斜着往下看（参数见 §6.1）。
- 搜索框居中放在墙面上方，旁边是「投一张」按钮。
- 左下角是计数和操作提示，右下角是库那叠纸和「库里 N 张」。

### 3.2 手机端（宽度 < 700px）

- 搜索框占满一行，「投一张」放在第二行右侧。
- 摄像机更高、更近，桌面占画面大部分（参数见 §6.1）。
- 纸团最多 10 个，库那叠纸放在下方偏右。
- 展开后纸面宽度不超过视口的 90%，动作条固定在底部。

### 3.3 导航

- 导航里 `/` 的标签从「投递」改为「桌面」（en：Desk）。投递入口搬到了桌面上。（我做的决定）
- Review 导航上的计数保持不变。

## 4. 桌上摆什么

服务端组装一个 `DeskItem[]`，按下面的优先级排，取前 N 个（桌面端 24 个，手机端由客户端截到 10 个）：

1. **分析中**：最新一次分析 run 为 `queued` 或 `running`、且还没有卡片或卡片仍是 `pending` 的投递，不限投递时间。需要新增查询 `listDeskRunning(pool)`，不复用只取最近 20 条的 `listRecentCaptures`。纸面是淡琥珀底，步骤用 `lib/captures/stage.ts` 的 `pipelineStages(kind, url)` 按投递类型生成（文本没有「看图」，YouTube 是「看片」），按 `okSteps` 点亮。已保留的卡片在详情页重跑，不会上桌。
2. **分析失败**：最近投递里 `runState = failed`、且没有生成卡片的。纸面写失败原因（沿用现有 errorCode 的文案），动作是「重跑分析」。
3. **待裁决**：`verdict = 'pending'` 的卡片，按创建时间倒序。`listPending` 每页只有 20 条，所以要新增 `listPendingForDesk(pool, limit)`。同一个 `captureId` 同时处于分析中和待裁决时（重跑中），只显示为分析中。纸面是完整卡片，加上一行建议「建议保留，置信度 0.72：理由…」。这一行沿用 `dict.suggestion` 的格式，是 Caphub 自己的写法，必须保留。

- 超出 N 张时，左下角显示「还有 M 张在 Review」，链接到 `/review`。
- 自动入库的卡片（置信度 ≥ 0.8 直接保留）不上桌。它们出现在库那叠纸的最上面：取最近 5 张保留的卡片（`verdict='keep'`、`status='active'`、未删除，按 `updated_at` 倒序），需要新增一个查询 `listLatestKept(pool, 5)`。
- 自动丢弃的卡片不显示。
- **桌上为空时**：桌面中央显示一行 HTML 文字「桌上没有要看的。投一张，或者搜一搜库里已有的。」，「投一张」按钮照常可用。

`DeskItem` 只放纸面和动作需要的字段（可序列化）：

```ts
type DeskItem =
  | { kind: "running"; captureId: string; createdAt: string; captureKind: "image" | "text" | "url"; url: string | null; okSteps: string[]; preview: string | null }
  | { kind: "failed"; captureId: string; createdAt: string; captureKind: "image" | "text" | "url"; errorCode: string | null; preview: string | null }
  | { kind: "pending"; id: string; captureId: string; updatedAt: string; createdAt: string;
      title: string; type: CapabilityType; summary: string; summaryPoints: Array<{ label: string; text: string }>;
      tags: string[]; usage: "integrate" | "reference"; score: number | null;
      suggestedVerdict: "keep" | "discard"; suggestedReason: string; confidence: number };
type PileItem = { id: string; captureId: string; serial: string | null; title: string; type: CapabilityType; summary: string; usage: "integrate" | "reference"; score: number | null };
```

- 每个纸团用稳定的 key：分析中和失败的用 `captureId`；待裁决的用卡片 `id`，同时记下 `captureId`，用来和之前的「分析中」纸团对上。
- 分析完成后，同一个 `captureId` 会从 running 变成 pending（或者被自动保留、自动丢弃）。客户端靠 `captureId` 认出是同一个纸团，不新建纸团：
  - 变成 pending：原地换成卡片纸面，纸团跳一下；
  - 被自动保留：抚平后飞进库那叠纸；
  - 被自动丢弃：揉起来扔走。
- 判断规则：某个 key 从桌上消失时，如果它的 `captureId` 出现在新的 `PileItem[]` 里，就飞进库那叠纸；否则（被丢弃、被删除、或保留后没排进最近 5 张）就揉起来扔走。

## 5. 交互

### 5.1 纸团

| 操作 | 结果 |
|---|---|
| 点击（按下后移动不到 6px） | 纸团飞到镜头前展开（约 0.75s，ease-out）。如果已经有一张展开的，那张先放回桌上 |
| 按住拖动 | 拿起纸团，跟随指针移动，会推开其他纸团 |
| 松手 | 按松手时的速度甩出去，在桌上滚一会儿停下 |
| 悬停 | 能拿的纸团显示 `grab` 光标 |

### 5.2 展开后

纸面是 3D 的，下方有一条 HTML 动作条。`/review` 用 Y/X/E/R，这里沿用同一套快捷键：

| 按钮 | 键 | 适用 | 动作与动画 |
|---|---|---|---|
| 保留 | Y | 待裁决 | 调 `decideAction(id, updatedAt, "keep")`。请求发出的同时，纸被抚平（展开帧到第 0 帧），沿弧线飞到库那叠纸的顶上，「库里 N 张」加一。失败时，纸回到展开状态，动作条下显示错误 |
| 丢弃 | X | 待裁决 | 调 `decideAction(…, "discard")`。纸揉起来，往墙后扔出去，然后从场景移除 |
| 改建议 | E | 待裁决 | 动作条上方弹出 HTML 面板，复用 `SuggestionEditor`。保存成功后，按「保留」的路径飞进库 |
| 重跑分析 | R | 待裁决、失败 | 调 `rerunAction(captureId)`。成功后，纸揉回纸团落到桌上，变成「分析中」（淡琥珀底） |
| 打开详情 | Enter（仅当焦点在动作条容器上） | 待裁决 | 跳到 `/library/[id]` |
| 放回桌上 | Esc | 全部 | 揉回纸团，轻轻抛回桌上 |

- 「分析中」的纸也可以展开，纸面上的步骤会实时更新。这时只能「放回桌上」。
- 按钮文案和 `/review` 一致，用「保留」「丢弃」，不用样稿里的「收进库」「揉掉」，同一个动作在全站只叫一个名字（我做的决定）。动画已经表达了收进库和揉掉的意思。
- 发生冲突（`reason === "CONFLICT"`）时，在动作条下显示现有的冲突文案，再调 `router.refresh()`。纸团会按新数据重新对齐，见 §4。
- 动作请求还没返回时，所有按钮都禁用，和 `ReviewCard` 的 busy 规则一样。
- 每个结果都用 toast 播报，同时写进 `aria-live` 区域：「已保留：<标题>」「已丢弃：<标题>」「已排队重跑」。`decideAction` 不返回编号，toast 不显示编号，也不为此改动共用的 `ActionResult`。

### 5.3 墙上的入口

- **搜索**：`<form action="/library" method="get">`，输入框 `name="q"`，提交后进入能力库现有的搜索，包括语义搜索和编号跳转。
  - 占位文字：「搜能力、标签，或输入编号 SKL-0157」。
  - 按 `/` 聚焦搜索框；焦点在输入框里时，Y/X/E/R 和 Esc 这些快捷键都不生效。
- **投一张**：打开一个 HTML 对话框（`<dialog>`），里面复用现有的 `CaptureForm`。
  - 给 `CaptureForm` 加两个可选 prop：`onSubmitted()`，在提交成功且不是重复投递时调用；`initialFile`。提交成功后关闭对话框，调 `router.refresh()`，新纸团从上方落下。遇到重复投递时不调用 `onSubmitted`，对话框保持打开，显示现有的重复提示。
  - 把图片文件直接拖到桌面上，也会打开对话框，并通过 `initialFile` 预先选好这个文件。
- **库那叠纸**：点击或回车进入 `/library`。悬停时显示「打开能力库」。

### 5.4 键盘与读屏

- 画布本身不可聚焦。画布前面渲染一个视觉隐藏的 `<ul>`，名称为「桌上的卡片」，每个纸团对应一个按钮，按钮名是标题，或者「分析中的投递」。
  - 按钮获得焦点时显示出来（类似 skip link 的样式），对应的纸团描一圈琥珀色边。
  - 按 Enter 展开该纸团。
- 纸展开后，焦点移到动作条容器本身（`role="toolbar"`、`tabIndex={-1}`），不落在「保留」按钮上，防止一次回车就误保留。Y/X/E/R/Enter/Esc 在这个容器上处理；焦点在某个按钮上时，回车只触发该按钮。全文（标题、类型、建议行、摘要、要点、标签）写进一个视觉隐藏的 `aria-live="polite"` 区域。
- 页面左下角有一个「换成列表」开关，状态存进 `localStorage`，读写都包 try/catch。列表视图就是服务端渲染的 HTML：桌上各项的简单列表加 `RecentRow`，每项链接到详情或 `/review`。
- 浏览器拿不到 WebGL 上下文时，自动切到列表视图，不显示开关。

### 5.5 减少动态效果

`prefers-reduced-motion: reduce` 时：
- 纸团直接出现在桌上，不从上方落下；
- 展开、放回、保留、丢弃都在 1 帧内完成，换成 150ms 的透明度过渡；
- 新投递不跳动；
- 拖拽和甩出照常可用，因为那是用户自己发起的。

## 6. 视觉与 3D 规格

### 6.1 场景（数值来自样稿，已经过截图验证）

- **颜色**：墙 `#f3b44a`（`--amber`），加 emissive 0.55，避免显得发灰；桌面 `#ece6d6`，加 emissive 0.18。场景背景色和墙同色。
- **灯光**：
  - 环境光 `#fff8ec`，强度 1.25；
  - 主光强度 1.15，位置 (-2, 2.6, 1.4)，开阴影，PCFSoft，2048 阴影贴图，bias -0.001。
- **后处理**：SSAO，kernelRadius 0.01、minDistance 0.0001、maxDistance 0.08，只在桌面端开。
- **摄像机**：fov 40。
  - 桌面端位置 (0, 2.25, 3.7)，看向 (0, 0.3, 0)；
  - 手机端位置 (0, 4.6, 4.3)，看向 (0, -0.05, 0)。
- **舞台范围**：
  - 桌面端 x ∈ [-2.4, 2.4]，z ∈ [-1.1, 1.7]；
  - 手机端 x ∈ [-0.95, 0.95]，z ∈ [-1.1, 1.75]；
  - 墙在 z = -1.1，地面 y = -0.1。
- **库那叠纸**：桌面端在 (1.3, 0.95)，缩放 0.5；手机端在 (0.42, 1.3)，缩放 0.48。每张纸平躺，绕 Y 轴随机偏 ±0.22 rad，每层高 0.006；配一个静态 box 碰撞体，纸团会被它挡住。
- **纸团**：
  - 收拢时缩放 0.82；
  - 物理参数：重力 -7，质量 0.16，纸对纸弹性 0.3，纸对地弹性 0.12；
  - 只在接触地面时加滚动阻力（线速度衰减 2.6，角速度衰减 4.5）；
  - 速度低于阈值持续 0.35s 后，判定为静止。
- **展开**：
  - 纸面朝向镜头，距离 1.5，停在第 4 帧（略带折痕）；
  - 高度占视口：桌面端 80%，手机端 70%；宽度不超过 90%；
  - 整体上移，给动作条留空间：桌面端上移视口高 4.5%，手机端 8%；
  - 展开中和展开后的纸不投阴影。

### 6.2 纸面（Canvas 2D）

- **尺寸**：设计坐标宽 1024、高 1434（比例 1:1.4），边距 92。纸团状态用 512 宽的纸面，展开时重画成 1024 宽，手机端用 760 宽。这样省显存。
- **底**：`#fbf8ee`，点阵间距 32、半径 2.1，颜色 `rgba(22,20,14,.14)`。分析中的纸改用 `#fdf2de`。
- **顶行**：
  - 编号用 IBM Plex Mono 600 36；
  - 「类型，相对时间」用 General Sans 400 31，颜色 `#6b6558`；
  - 评分是右侧 5 个竖格（13×26），4 分及以下实心格为墨色，5 分为琥珀色描 `#7a4f00`；
  - 顶行下面一条 2px 的发丝线。
- **待裁决的纸面**：没有编号（`displaySerial` 对 pending 返回 null），编号的位置写「待决」。
- **建议行**：新增，放在顶行下面，General Sans 500 30。
  - 建议保留时，琥珀浅底 `#fdf2de`、文字 `#7a4f00`；建议丢弃时，墨色描边。
  - 文案沿用 `dict.suggestion`，最多 2 行。
- **标题**：General Sans 600，62（没有要点时用 74，手机端用 78），行高 1.24，最多 3 行。
- **摘要**：400，33（没有要点时用 40，手机端用 46），颜色 `#4a463c`，行高 1.62，最多 5 到 8 行。
- **要点**：从 `summaryPoints` 取最多 4 条。标签用 Plex Mono 500 25，正文 400 30、缩进 150、每条最多 2 行。手机端不显示要点。
- **大号编号**：剩余空白超过 380 时，在页脚上方印一个大号编号，Plex Mono 600 168，透明度 0.08。只有正式卡片才印。
- **页脚**：发丝线；左侧是标签（Plex Mono 28），右侧是用法：实心方块表示「直接整合」，空心方块表示「参考自研」。
- **字体**：等 `document.fonts.load` 完成后，重画所有纸面。CJK 字体回退到 PingFang SC、Hiragino Sans GB、Noto Sans SC。
- **贴图朝向**：`texture.rotation = π`、`center (0.5, 0.5)`、`repeat (1, -1)`。网格的 UV 要求这样设置。
- **材质**：`MeshStandardMaterial`，roughness 0.9，DoubleSide，`emissiveMap` 用同一张贴图，emissive 白色、强度 0.2，让纸面不发灰。

### 6.3 HTML 叠层

- 用现有的 token：`--ink`、`--paper`、`--amber`、`--amber-text`、General Sans、Plex Mono。
- 动作条：墨色底，圆角 10，内边距 8。「保留」用琥珀底墨字，其余按钮透明底。按钮里的 `kbd` 用 Plex Mono 11。
- 不新增渐变、投影卡片网格或胶囊筛选条，遵守 `docs/design/anti-defaults.md`。

## 7. 技术方案

- **依赖**：新增 `three`（锁定一个确切版本，按 0.160 的 API 写，如果用更新的版本，需要确认 `FBXLoader`、`EXRLoader`、`SSAOPass` 的导入路径）和 `cannon-es@0.20.0`。只在客户端动态 `import()`，不进服务端 bundle。
- **资源**：
  - 把样稿 `vat/geo/vertex_animation_textures1_mesh.fbx`（1.2MB）和 `vat/tex/vertex_animation_textures1_pos.exr`（1.7MB）放进 `public/vat/`，注意保持原名。获取地址是 `https://raw.githubusercontent.com/item-develop/paper-crumple-demo/HEAD/<路径>`，下载后核对文件大小（1249769 和 1745336 字节）。
  - 把 MIT 许可全文和出处写进 `public/vat/LICENSE`，再在 `THIRD_PARTY_NOTICES.md`（新建）里登记。
- **VAT 解码**：移植原仓库的 `src/paper-vat.js`，可以改写成 TypeScript。要点：
  - 先用 UV2（FBXLoader 里叫 `uv1`）算出每个顶点对应的点 ID；
  - EXR 的行要整体上下翻转，X 位移取反；
  - UV2 为 (0, 0) 的 6 个占位顶点要去掉；
  - 按点 ID 累加面法线，得到平滑法线；
  - 掐掉首尾的静止帧；
  - 算出 `flat`（宽、深、中心）和 `crumple`（中心、P90 半径）。
  
  解码结果缓存在模块作用域，在页面之间切换时不重复解码。
- **回放**：在 CPU 端做相邻帧插值，写进 `BufferAttribute`，然后更新包围球。只有正在动画的纸逐帧更新顶点。
- **渲染节流**：
  - 所有刚体都静止、没有动画、没有拖拽时，停止 `setAnimationLoop`；有输入、数据变化或窗口尺寸变化时再恢复。
  - `document.hidden` 时暂停。
  - `devicePixelRatio` 上限为 2。
- **组件划分**（建议，实现者可以调整）：
  - `app/(chrome)/page.tsx`：服务端组装 `DeskItem[]`、`PileItem[]` 和计数，渲染 `<Desk>` 与列表后备视图。主页不再用 `PipelineWatcher`：它在输入框有焦点时会跳过刷新（`components/shell/pipeline-watcher.tsx`），搜索框又常常有焦点。改由 `Desk` 自己刷新：桌上有分析中的纸团时，每 3 秒调一次 `router.refresh()`，只在投递对话框打开时暂停。搜索输入框放在 `Desk` 这个 client 组件里，这样刷新不会清掉已输入的内容。
  - 页面内容外层有 `max-width: 1232px`（`app/globals.css` 的 `.main-content` 一带），主页需要一个修饰类，让场景突破这个宽度、占满整宽。
  - `components/desk/desk.tsx`（client）：负责墙上的入口、动作条、对话框、可访问列表、toast、列表开关。它把场景当成一个命令式对象使用，接口如 `scene.sync(items)`、`scene.open(key)`、`scene.file(key)`、`scene.trash(key)`、`scene.putBack()`，事件如 `onOpen`、`onPick`。
  - `components/desk/scene/`：three.js 和物理部分，分成 VAT 加载、纸团状态机、纸面绘制、库那叠纸几个文件。
  - `components/desk/desk-items.ts`：纯函数，包括由查询结果组装 `DeskItem`，以及按 key 和 captureId 比较前后两次数据、输出 spawn、update、promote、file、trash、remove 指令。
  - `lib/library/queries.ts`（或 `lib/captures/captures.ts`）：新增 `listLatestKept`、`listPendingForDesk`、`listDeskRunning`。
- **i18n**：新文案的中文和英文都要加进 `dict-zh.ts`、`dict-en.ts`。

## 8. 验收标准

1. 主页的服务端 HTML 里，在 JS 加载前就有可用的搜索框（GET `/library`）、「投一张」按钮和桌上卡片列表。
2. 桌面上能看到全部三类纸团：分析中、失败、待裁决。展开后，纸面内容和 §6.2 一致，字号满足 §2 反目标里的下限。
3. Y、X、E、R、Enter、Esc 在展开状态下都按 §5.2 生效，请求参数和 `/review` 一致。冲突时显示提示并刷新数据。
4. 一张投递从提交到分析完成，在桌上表现为：落下，然后步骤逐个点亮，最后原地换成卡片并跳一下（或者飞进库那叠纸、被扔走）。过程中不会出现重复的纸团。
5. 不调用 WebGL 也能走完：列表开关和无 WebGL 后备视图都能完成搜索、投递，以及进入 `/review` 和详情。
6. 只用键盘和读屏软件也能走完：可以聚焦桌上卡片列表的按钮并展开，动作条可用，全文会被播报。
7. 场景静止 2 秒后不再请求动画帧（可以用测试钩子或 performance 记录验证）。
8. 3D 代码不进服务端 bundle，主页首屏 JS 不包含 three.js（动态 chunk）。
9. `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 全部通过。新增的单元测试至少覆盖：
   - `desk-items` 的组装与比较；
   - 纸面换行和截断函数；
   - `listLatestKept`（mock pool）；
   - `Desk` 组件的动作条：调用正确的 action，busy 期间禁用，冲突时的处理；
   - 列表后备视图。
   
   jsdom 里不跑 WebGL，测试时 mock 掉场景模块。

## 9. 留给实现者决定

- 纸面绘制和网格的具体函数怎么拆。
- 场景暴露的命令式接口的确切形状。
- toast 的视觉细节。
- 「分析失败」纸面上失败原因的文案：复用 `RecentRow` 里现有的映射，如果没有就新增中文和英文两份。

## 10. 风险

- **资源体积**：首次访问要多下载约 3MB（FBX + EXR）和 three.js（gzip 后约 150KB）。可以接受，前提是场景在首屏之后才加载，并且服务端设置长缓存。
- **低端手机发热**：靠 §7 的渲染节流和手机端关闭 SSAO 缓解。
- **纸面文字不可访问**：靠 §5.4 的隐藏列表和 live 区域补上。详情仍以 HTML 页面为准。
