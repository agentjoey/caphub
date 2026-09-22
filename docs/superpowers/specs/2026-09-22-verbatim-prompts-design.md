# Prompt 原文独立保存与展示 — 设计

日期：2026-09-22 · 状态：已批准（Joey，2026-09-22）

## 目标

所有 prompt 类型的能力，把 prompt 从卡片里单独提取出来、单独展示；保存的必须是输入源里的 prompt 原文，不得提炼、改写、翻译或补全。

## 现状问题

- `playbook.prompt_text` 只存在于 `integrate` playbook；`reference` 卡没有原文字段，原文被塞进 `summary_points` / `playbook.points`（例：PRM-0022、PRM-0023）。当时 12 张 prompt 卡中 7 张属于这种情况。
- 原文由分析模型（reason）「给出 prompt 全文」，补充调研（enrich）还会整卡重写 `playbook`，两处都可能改写原文。
- `prompt_text` 上限 8000 字，更长会校验失败。
- 展示夹在「怎么用」里，没有独立区块。
- 网页抓取 `stripHtml` 把所有空白压成一个空格，原文换行丢失。

## 决定

- 一个输入源里有多条 prompt 时，每条单独保留、单独复制；合集页面只保留输入源里实际出现的条目，不去抓整个库。
- 原文由代码从输入源摘取后固定（方案 A），模型不能写这个字段。
- 存量卡从已存的看图记录回填，不调模型。

## 1. 数据

迁移 `014_verbatim_prompts.sql`：

- `caphub_v2.capabilities.prompts jsonb NOT NULL DEFAULT '[]'`：数组，元素 `{ "text": string }`，保留换行与空白；单条 ≤ 20,000 字，最多 20 条（Zod 在写入前校验）。
- `caphub_v2.capabilities.prompt_unresolved smallint NOT NULL DEFAULT 0`：本次分析中未能在原文中定位的条目数，供 Review 提示。

`playbookSchema` 的 `integrate` 分支删除 `prompt_text`（只留 `install`、`repo`）。旧行里残留的 `prompt_text` 由回填脚本清掉；读取端用 Zod 解析时忽略多余字段，回填前后都能正常展示。

## 2. 摘取

所有路径都只把**输入源**（截图 / 投递文字 / 抓取的网页正文）当作原文来源，联网搜索结果永远不算。

### 截图

`extractionSchema.prompt_text: string | null` 改为 `prompts: string[]`（≤ 20 条）。`visionPrompt` 要求：图中每条完整 prompt 单独一项，逐字抄录，不翻译、不润色、不补全、不合并；中英对照的两版算两条。截图是像素，抄录本身无法由代码逐字验证，这是截图输入的上限。

### 文字、网页

reason 输出新增 `prompt_locators: { start: string; end: string }[]`（≤ 20 条），`start` / `end` 为该条 prompt 在原文中的开头、结尾各约 20 字，须逐字照抄。代码（`lib/analysis/prompt-locate.ts`）：

1. 在原文中从上一条结束位置起查找 `start`，再从 `start` 处查找 `end`，截取 `[start 起点, end 终点)` 整段。
2. 两个锚点都找到才算成功；存下来的是原文里的那一段，因此与原文逐字一致。
3. 找不到的条目丢弃，计入 `prompt_unresolved`。
4. 定位所用的文本与 reason 提示里给模型看的原文是同一份（文字投递为 `captures.text` 全文，网页为保留换行的正文），不能一边截断一边全文。

截图输入时忽略 `prompt_locators`，只用抄录结果。

### 网页抓取

`fetchUrlText` 增加保留换行的正文（`<br>`、块级标签转换行，行内连续空白压成一个，行间保留），上限提高到 100 KB；现有压平版本保留给搜索词等用途。reason 提示里的「页面正文」改用保留换行版本并控制在预算内。

### 写入与隔离

- `upsertCapability` 与卡片在同一事务写入 `prompts`、`prompt_unresolved`；重跑时整列覆盖（仍只来自输入源）。
- enrich、deep 的读取与写回 SQL 不包含这两列；它们的 schema 不含原文字段。
- reason、enrich、deep 的提示词加一句：「prompt 原文由系统单独保存，不要在 summary、summary_points、playbook 里复述原文」。

### 自动通过规则

`decideVerdict` 增加：`prompt_unresolved > 0`，或 `type = prompt` 且 `prompts` 为空且建议为 keep 时，一律 `pending`（进 Review），不论置信度。

## 3. 展示

- Web 详情页 `app/(chrome)/library/[id]/page.tsx` 与 Mini 详情页 `app/mini/library/[id]/page.tsx`：新增独立面板「Prompt 原文」，放在「怎么用」之前；每条一个 `<pre>` 代码块、各自一个复制按钮，全文显示、保留换行、不截断。`prompts` 非空即显示，不限类型。
- `PlaybookView` 删除 prompt 块。
- Review 页（web / mini）：`prompt_unresolved > 0` 时提示「有 N 条原文未能定位」；`type = prompt` 且 `prompts` 为空时提示「未摘到 prompt 原文」。
- MCP `get_capability` 输出增加 `prompts`（字符串数组）。
- 中英文案进 `lib/i18n`。

## 4. 存量回填

脚本 `scripts/backfill-prompts.ts`（不调模型，支持 `--dry-run`）。对每张卡：

1. 取该卡最近一次成功的 `vision` 步骤输出中的 `prompt_text`（当时逐字抄录的结果），非空则作为一条原文。
2. 否则若来源是文字投递，且旧 `playbook.prompt_text` 逐字出现在 `captures.text` 中，采用它。
3. 两条都不满足的卡列出来，不写入，交 Joey 逐张决定。
4. 同时从 `playbook` 中删除 `prompt_text` 键。

执行顺序：

1. 临时 Neon branch：迁移 014，跑回填 `--dry-run` 与正式回填，把每张卡的回填内容列给 Joey 确认。
2. 确认后：生产库执行迁移 014，再执行回填（生产写入需 Joey 授权），然后推送代码。部署不跑迁移，必须先迁移再推送。
3. 删除临时 branch。

## 测试

- `prompt-locate`：正常定位、锚点重复（按顺序取）、锚点找不到、中英混排、跨换行。
- 分析流程：截图路径写入抄录结果；文字路径写入定位结果与 `prompt_unresolved`；enrich 不改变 `prompts`。
- `decideVerdict` 新规则。
- `fetchUrlText` 保留换行版本。
- 详情面板、Review 提示渲染；MCP 输出含 `prompts`。
- 本地 `localhost` 截图检查 web 与 Mini 两端（桌面与手机宽度，无横向溢出）。
- 测试不连真实数据库和模型；真实验证只用临时 Neon branch。

## 不做

- 不从合集网站抓取全部 prompt。
- 不对截图抄录做二次模型核对。
- 不改卡片列表与搜索结果的展示。
