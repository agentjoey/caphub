# Caphub v2 设计（AJ-001 / AJ-005）

日期：2026-09-19 · 状态：设计已逐节批准，待 Human 审阅全文
关联：Notion backlog AJ-001（Caphub Re-design）、AJ-002（Telegram 前端）、AJ-005（Caphub 迁移到云服务）

## 1. 定位与目标

Caphub 是 Joey 的**个人 agent 能力库**。能力类型：skill、经验（experience）、plugin、prompt、其他。

核心闭环：输入（图片 / 文字 / URL）→ 搜索、评估、分析 → 有价值的建档、无价值的丢弃 → 标注"直接整合"或"参考自研"并附落地清单 → 分类打标 → 日后按类型 / 标签 / 全文搜索查找。

入口：web 与 Telegram 私聊 bot。知识库：Obsidian Vault 作为只读投影。

## 2. 已定决策

| 议题 | 决定 |
|---|---|
| 唯一事实源 | Neon PostgreSQL；Obsidian 是只读投影 |
| 保留 / 丢弃 | 分级：置信度高的自动执行，中间段进人工 Review |
| Review 卡内容 | 一句话、类型、AI 建议 + 理由、完整分析摘要、原始输入、拟打标签；其余折叠 |
| 查找 / 推荐 | 本期只做人用的 web 查找（全文检索 + 筛选）；agent 接口留下一期 |
| Telegram | 投递 + 结果推送 + 按钮直接决定；只认一个 chat id |
| 整合 / 参考 | 标记 + 落地清单，不自动安装 |
| 标签 | 类型固定枚举；用途标签 AI 自由生成，优先复用已有 |
| 经验类型 | 提炼后**保留核心内容本身**（prompt 原文、方法步骤） |
| 现有数据 | 导入 v2 重跑，作为测试数据；上线前删除；web 有手动删除 |
| 架构 | v2 平行重建为**独立仓库 + 独立云服务（Railway）**；Planning Core 留在本机 |
| 模型 | A（MiniMax 一条龙）与 B（MiniMax 看图 + Tavily + DeepSeek）真实对比后定型；DeepSeek 作为人工触发的复核 |
| 沿用范围 | 见 §10 |

## 3. 系统边界与部署

### 3.1 仓库

新建独立仓库 `agentjoey/caphub`，本地路径 `~/AgentWorks/CodeSpace/Caphub`。沿用代码从 alljobs 复制（含对应测试）。alljobs 内旧 Caphub 在 v2 验收后整体删除，header 的 "Caphub" 改为外链。

Planning Core（`lib/planning`、`app/projects|tasks|monitoring`）与 Caphub 零代码耦合，唯一共享的是配置加载器；v2 改用环境变量后彻底解耦。

### 3.2 服务（Railway，同一 project）

| 服务 | 职责 | 入站 |
|---|---|---|
| `web` | Next.js 16 App Router：投递、Review、能力库、详情、复核触发；写操作用 server action | 公网域名 |
| `worker` | 单 Node 进程：分析队列消费（租约 / 心跳）、每小时保留期清扫、Telegram 长轮询 | 无 |

Telegram 采用长轮询而非 webhook：web 域名前有 Cloudflare Access，回调进不来；长轮询只出不进。

### 3.3 数据

继续使用 Neon project `caphub`（数据库 `caphub`）和桶 `caphub-objects`。v2 使用新 schema `caphub_v2`（§4），不复用 v1 的事件溯源表。图片 sha256 内容寻址，30 天后清扫。

### 3.4 鉴权

- 域名 `caphub.agentjoey.ai` 挂 Cloudflare，Access 沿用邮箱验证码策略。
- 应用校验每个请求的 `Cf-Access-Jwt-Assertion`（AUD 由环境变量提供）；直连 Railway 域名被拒。
- Telegram 只处理 `chat.id == TELEGRAM_OWNER_CHAT_ID` 的消息，其余静默丢弃并计数。

### 3.5 配置

全部环境变量，无 `config.json`：
`DATABASE_URL`、`DATABASE_URL_READONLY`（vault-sync 用）、S3 端点 / 桶 / 凭证、`MINIMAX_API_KEY`、`DEEPSEEK_API_KEY`、`TAVILY_API_KEY`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_OWNER_CHAT_ID`、`CF_ACCESS_AUD`、`CF_ACCESS_TEAM_DOMAIN`、`PIPELINE`（`minimax` | `mixed`）、`VERDICT_AUTO_THRESHOLD`（默认 0.8；对 AI 建议的置信度，keep / discard 共用）。
开关：`ANALYSIS_ENABLED`、`RETENTION_ENABLED`、`TELEGRAM_ENABLED`。

### 3.6 成本控制

- Neon scale-to-zero；图片 30 天清扫。
- `worker` 是唯一常驻进程，最低配、单副本；`web` 无流量时允许休眠。
- 模型调用：搜索正文截断、调模型前去重、失败不自动重跑、单 run 调用与 token 上限（§5.5）。
- spike 记录每张卡的 token 与耗时，得到真实单价。Railway 套餐价格在写实现计划时查官方文档核实。

### 3.7 本机组件

只剩 `caphub-vault-sync`（§8），用 launchd 每小时运行或手动运行。

## 4. 数据模型（schema `caphub_v2`）

普通可更新行，不做追加式事件溯源。

**`captures`** — 每次投递一条
`id`, `source` (web|telegram), `kind` (image|text|url), `object_key`, `text`, `url`, `dedupe_key` (内容 sha256, 唯一), `telegram_chat_id`, `telegram_message_id`, `created_at`

**`analysis_runs`** — 每次分析一条；一个 capture 可多次（重跑、A/B）
`id`, `capture_id`, `pipeline` (minimax|mixed), `state` (queued|running|done|failed), `lease_until`, `owner_token`, `attempts`, `error_code`, `error_message`, `started_at`, `finished_at`, `created_at`

**`analysis_steps`** — 每次模型 / 搜索调用一条
`id`, `run_id`, `step` (vision|search|reason|review), `provider`, `model`, `input_tokens`, `output_tokens`, `duration_ms`, `ok`, `error`, `output` (jsonb), `created_at`

**`capabilities`** — 能力档案；一个 capture 最多一条
- 卡片：`title`, `type` (skill|experience|plugin|prompt|other), `summary`, `signals` (jsonb, 2–3 条)
- 裁决：`suggested_verdict` (keep|discard), `suggested_reason`, `confidence` (0–1), `verdict` (keep|discard|pending), `verdict_by` (auto|human), `verdict_at`
- 用法：`usage` (integrate|reference), `playbook` (jsonb)
- `tags` (text[]), `source_url`, `review_note` (jsonb, 可空), `notified_at`, `synced_at`, `deleted_at`, `created_at`, `updated_at`
- `capture_id`, `run_id` 外键

`playbook` 形状按 `usage` / `type`：integrate → `{install: string[], repo?: string, prompt_text?: string}`；reference → `{points: string[]}`；experience → `{content: string, when_to_use: string}`。

**`tags`** — `name` (唯一), `use_count`, `created_at`

**`retention`** — `object_key`, `eligible_at`, `purged_at`（沿用现有语义与清扫逻辑）

取舍：
- 无 reviews 表：Review = `verdict = pending` 的 capabilities 行。人工决定更新该行，乐观锁用 `updated_at`。
- 无 lineage 表：capture → run → capability 外键链。
- 分级阈值是配置不是表字段。
- 手动删除是软删（`deleted_at`），30 天后随清扫硬删并清扫对象。

## 5. 分析与裁决

### 5.1 管线接口

一次 run = 有序 step 列表。每个 step：输入前一步的结构化产物，输出经 Zod 校验的 JSON，写一行 `analysis_steps`。A / B 仅 step 实现不同，卡片 schema 与裁决逻辑相同；切换靠 `PIPELINE` 环境变量或 run 参数。

### 5.2 素材准备（不调模型）

- 图片：sharp 归一化 + OCR（沿用 preprocess）。
- 文本：直接进 reason。
- URL：服务端抓取（仅 https，超时 15 s，正文上限 20 KB），当作文本；抓取失败则把 URL 交给 search。

### 5.3 Step 序列

| Step | A `minimax` | B `mixed` |
|---|---|---|
| vision（仅图片） | MiniMax-M3 看图，直接输出 `Extraction` JSON：是什么、来源线索、可见的命令 / prompt 原文、疑问 | 同左 |
| search | MiniMax 原生 web_search；每条来源正文截到 2 KB，最多 6 条 | Tavily；同样上限 |
| reason | MiniMax：核对来源、判断类型、评估价值、给出 suggested_verdict + confidence、usage、playbook、tags，并直接产出卡片 | DeepSeek 做同一件事 |

典型 3 次调用（文本 / URL 输入为 2 次）。reason 输入附带：库内相似能力（title + tags 文本匹配前 5 条）、现有标签前 100 个。

### 5.4 复核（人工触发）

详情页"复核"按钮 → 一次 DeepSeek 调用，输入 = 卡片 + reason 步完整产物，输出 `review_note = {agrees: boolean, points: string[]}`。只写 `review_note`，不改裁决。写一行 `analysis_steps(step = review)`。

### 5.5 分级裁决（worker 在卡片落库后执行）

- `confidence ≥ VERDICT_AUTO_THRESHOLD` 且建议 keep → `verdict = keep, verdict_by = auto`
- `confidence ≥ VERDICT_AUTO_THRESHOLD` 且建议 discard → `verdict = discard, verdict_by = auto`
- 否则 → `pending`
- 自动 keep 保留"改建议"入口；自动 discard 可在库页"已丢弃"筛选中找回。

### 5.6 预算与失败

- 超时：vision 60 s、search 60 s、reason 120 s、review 120 s。
- Zod 校验失败允许一次纠错重试；其余不重试。
- 单 run 上限 4 次调用、200,000 token；超限 → `failed`。
- 失败 run 在 web 显示原因，可手动重跑（新建 run）；不自动重跑。
- 队列全局并发 1（沿用）。
- 去重在入队前：`dedupe_key` 命中即不入队，返回已有 capture。

## 6. Web 端

导航：`投递` · `Review` · `能力库`。Paper Workbench 风格沿用，不引入新组件库。

- **投递 `/`**：单一输入框（拖图 / 粘贴文字 / 粘贴 URL，自动识别，上限 10 MB）；下方最近 20 条投递及状态（排队 / 分析中 / 已建卡 / 失败 + 重跑 / 重复 → 已有卡）。
- **Review `/review`**：仅 `pending`，倒序分页 20。卡片六项（§2）。操作：保留 / 丢弃 / 改建议（类型、usage、标签，保存即保留）。分析原文、来源、每步 token 与耗时在"详情"折叠区。冲突时卡片置灰提示"已在别处处理"。
- **能力库 `/library`**：顶部统计条（按类型计数、标签数、待 Review 数）；默认 `keep` 且未删除；筛选：类型、标签多选、usage、"已丢弃"开关；搜索：Postgres 全文检索（title + summary + playbook + tags）。列表项：一句话、类型、标签、usage。
- **详情 `/library/[id]`**：卡 + playbook（integrate → 可复制命令 / prompt 全文；reference → 要点；experience → 核心内容）。操作：改建议、复核、重跑分析、删除（软删，一次二次确认，无确认短语）。显示 `synced_at`。

不做：dashboard、批量操作、导入导出页、向量推荐。

## 7. Telegram

- worker 内长轮询 `getUpdates`；仅处理 owner chat id。
- 投递：图片（相册逐张）、文字、URL → 回复 `已收到 #<短id>，分析中`；重复 → `重复：与 #<id> 相同`。纯 URL 文本按 URL 处理。
- 推送（裁决后）：
  - auto keep：`✅ 已保留 · <一句话> · [类型] · 标签` + 详情链接
  - auto discard：`🗑 已丢弃 · <一句话> · 理由` + 找回链接
  - pending：精简卡（一句话、类型、建议 + 理由、摘要前 300 字、标签）+ inline 按钮 **保留 / 丢弃 / 在 web 里改**（URL 按钮）
  - failed：`❌ 分析失败 · 原因` + 重跑链接
- 按钮回调携带 `capability_id` + `updated_at`，调用与 web 相同的决定函数；成功后编辑原消息为结果并移除按钮；冲突编辑为 `已在 web 处理`。
- 可靠性：断线重连；`notified_at` 为空的卡每轮补发；日志不含图片内容与 token。
- 与 Claude Code 的 telegram 插件无关，是另一个 bot 与 token。

## 8. Obsidian 投影

- 命令 `scripts/vault-sync.ts`，本机 launchd 每小时或手动；单向 Neon → Vault；使用只读角色 + 一个仅允许 `UPDATE capabilities.synced_at` 的角色。
- 仅同步 `verdict = keep` 且未删除。路径 `<Vault>/Caphub/<type>/<slug>-<短id>.md`；索引页 `<Vault>/Caphub/Index.md` 按类型列 wiki link。
- frontmatter：`caphub_id, type, usage, tags, source_url, created, synced, digest`。正文：一句话 → 摘要 → 价值信号 → playbook。
- 托管区标记 `<!-- caphub:managed:start/end -->`：标记外内容不动；标记内 digest 不匹配 → 写 `.conflict.md`，不覆盖。
- 卡被丢弃 / 删除 → Vault 文件不删，frontmatter 加 `caphub_status: removed`。
- 验收：先同步到临时 Vault 目录验证，通过后才指向真 Vault。

## 9. 迁移、测试与上线

### 9.1 子项目

| # | 子项目 | 产出 | 验收 |
|---|---|---|---|
| 1 | 地基 + 管线 | 新仓库、Railway 两服务、`caphub_v2` schema、队列、A/B 管线、裁决、复核、最简投递页、旧数据导入命令 | A/B spike 完成并定型；每步耗时 / token 有记录 |
| 2 | Web 端 | Review、能力库（含统计）、详情、改建议 / 删除 / 重跑 | Human 用旧数据走完一轮 Review |
| 3 | Telegram | 投递、推送、按钮决定 | 手机发图 → 收卡 → 按钮决定 → web 可见 |
| 4 | Obsidian + 收尾 | vault-sync；alljobs 外链、旧代码删除、旧 schema drop | 临时 Vault 通过；alljobs 删旧 Caphub 后测试全绿 |

### 9.2 旧数据

子项目 1 提供一次性命令：读取 v1 Registry 的 capture（图片仍在同一桶）→ 写入 `caphub_v2.captures` → 按新管线重跑。这批数据用于 spike 与 Review 测试；上线前由 Human 用删除按钮或清库命令清除。v1 schema 在子项目 4 验收后 drop。实际条数在写子项目 1 计划时查询（需一次只读授权）。

### 9.3 A/B spike

同一批旧 capture 各跑 A、B，产出表：每步耗时、token、成本估算、Human 1–5 分主观评分。定型后另一条管线保留，靠配置切换。需要授权真实调用并提供 Tavily key。

### 9.4 测试

- 单元：每步 schema、裁决阈值、乐观锁、去重、Telegram 消息解析；假 provider，不打真实 API。
- 集成：Vitest + 临时 Neon branch（测完删）：队列 / 租约 / 导入 / vault-sync。
- E2E：一套 Playwright 配置：投递 → Review → 库 + axe。
- 真实调用仅在 spike 与上线冒烟中发生，逐次授权。

### 9.5 上线顺序（每步可独立回退，前一步不成功不进下一步）

Railway 自带域名 + Access JWT 校验跑通 → 挂 `caphub.agentjoey.ai` → 开 Telegram → vault-sync 指向真 Vault → alljobs 外链上线、旧 worker 卸载、旧路由删除、v1 schema drop。

### 9.6 需要 Human 逐项授权的动作

建 GitHub repo、建 Railway project、Neon 建 schema 与角色、真实模型 / Tavily 调用、Cloudflare DNS / Access 变更、drop v1 schema、删除 alljobs 旧代码。

## 10. 从 v1 沿用范围（已批准）

**直接沿用**：队列 / 租约 / 心跳；去重与内容寻址（去掉已跑完的回填分支）；Neon S3 客户端；保留期清扫；MiniMax / DeepSeek 适配器与"结构化输出 + Zod + 一次纠错"通用层；阶段式可续跑 runner；决定的乐观锁思路；API route factory；投递表单。

**改造后沿用**：分页 / 筛选逻辑（重写展平 SQL）；配置改为环境变量；Obsidian 渲染（托管区标记 + digest）与规划。

**丢弃**：Kimi 全部代码与 debug zip；本地文件系统存储平行实现；发布 / 部署计划 / release candidate / 包仓库 / codex-claude-hermes 适配器；v1 review dossier UI 与确认短语流程；一半 CLI 脚本（publish / release / export / preflight / 一次性回填）；五套 Playwright 配置合并为一套；`app/capabilities/[id]/page.tsx` 重写。

## 11. 评估依据摘要

- v1 管线 6 次串行调用；唯一生产记录总 158,674 token，其中 web_search 一次 114,062（正文全文入上下文）；无耗时记录；图片仅被看一次且无重试；review packet 为拼接产物，UI 几乎全渲染——这是 Review 页杂乱的根因。
- DeepSeek 适配器不发图片、无工具；MiniMax 有视觉与原生搜索。故任何方案都需一次视觉调用，搜索可控性比模型数量更关键。
- Planning Core 无任何对 Caphub 的引用；Caphub 仅引用 Planning 的配置加载器。

## 12. 下一期（不在本 spec 内）

agent 查询接口（skill / MCP）、自动安装、向量推荐、多用户。
