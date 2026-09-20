# Caphub v2 — M3.7（入库补充调研：卡片写能力本身，不写分析过程）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 决定留下的卡，内容要写这个能力是什么、怎么用、值不值，而不是"我搜得顺不顺利"；原始截图退居为线索。

**Spec:** `docs/superpowers/specs/2026-09-19-caphub-v2-design.md`。本文件的「设计决定」是增补，2026-09-20 由 Human 选定。

## 问题（来自 TOL-0045 的实例）

现有卡片的摘要有大半在讲分析过程：「经联网核实…但检索到的外部来源均为同类产品，未直接证实该页面的免费额度、导出格式清单与是否需要登录」。而卡里就有权威 URL（`logoai.com/design/animated-logo`），管线**从未打开过它**——只拿提取结果去 Tavily 搜关键词，搜到的是同类产品，于是只能写「未验证」。

根因有两条，都要治：
1. **没读第一手来源**：搜索是"找相关的"，不是"读这一页"。
2. **提示词没要求写什么**：没说清摘要写能力本身，可信度只该占一条信号。

## 设计决定（Human 已选定）

1. **两轮**：
   - **第一轮（现状，约 3 次调用）**只负责判断留不留：看图 → 搜索 → 写卡 → 分级裁决。目标是快和省，不追求写得充分。
   - **第二轮（补充调研，约 4 次调用）**只在卡**进入 keep** 时触发：自动裁决 keep（置信度 ≥ 0.8）时立刻排队；人工在 Review 或详情页点保留时同样排队。丢弃与待决的卡不花这笔钱。
2. **第二轮重写模型写的，保留人工改的**：`summary`、`signals`、`playbook`、`source_facts`、`score`、`score_reason` 全部重写；**人工改过的 `type` / `usage` / `tags` 不动**（现有 `type_by='human'` 只盖住类型，本期扩成覆盖整次「改建议」）。旧版本留在分析记录里可查。
3. **第二轮的步骤**：
   - 抓取权威来源（不算模型调用）：提取到的 URL 直接抓页面；GitHub 仓库额外取 README 与仓库元数据（star、许可证、最近更新）——`source_facts` 那几项本该来自这里，而不是靠搜索碰运气；
   - 针对第一轮留下的疑问做 ≤ 2 次定向检索；
   - 一次 DeepSeek 重写整张卡。
4. **第一轮产出待核实清单**：卡片 schema 增加 `open_questions`（0–3 条，每条 ≤ 30 字），第一轮把"看图看不出、需要核实"的点写进去，第二轮拿它当检索目标。第二轮结束后仍未解决的，保留在卡上以「待核实」小字呈现。
5. **摘要写能力本身**：提示词明确——`summary` 写这个能力是什么、解决什么、怎么用、边界在哪；**可信度与来源只能占 `signals` 的一条**，不得进入摘要；禁止「未直接证实」「待实测」这类过程叙述占据正文。
6. **淡化原始输入**：详情页把截图从右栏主位改为可折叠的小图（默认折叠，标题为「原始投递」）；列表行缩略图不变。
7. **存量全部补跑**：库里 41 张有效卡全部跑一遍第二轮（约 150 次调用，Human 已确认）。
8. **与深度分析的关系**：深度分析仍是手工触发的重活（约 8 次调用，产出独立版块）；第二轮是入库标配的轻量调研，二者不合并。

## 需要 Human 授权

- 生产 Neon 执行迁移 011。
- 真实调用：新卡每次入库多约 4 次；存量补跑一次性约 150 次。
- 抓取外部页面（权威来源）：带超时、大小上限、仅 http(s)。
- 临时 Neon branch 验证（建 / 删）。

## Global Constraints

沿用既有约定，另加：
- 第二轮是独立 run（`analysis_runs.kind='enrich'`），自有预算 5 次调用 / 250k tokens、超时 3 分钟、同卡同时仅一个（唯一索引），与分析 / 深度分析三者互不占用。
- 抓取外部页面：仅 http(s)、10 s 超时、正文截断至既有来源上限、失败即跳过并退回检索，绝不让第二轮整体失败。
- `source_facts` 仍禁止推测：抓到什么写什么，抓不到就留空。
- 第二轮不改 `verdict`、`verdict_by`、`status`、`progress`、`deep_analysis`，也不清 `notified_at`（避免重复推送）；写完只更新 `updated_at`（会触发重新计算向量，可接受）。
- 人工改过的字段以显式标记为准，不靠"猜哪些像人写的"。

---

### Task 1: 迁移 011 + 人工编辑标记 + 待核实清单

**Files:** `lib/db/migrations/011_enrichment.sql`、`lib/analysis/card.ts`、`lib/analysis/prompts.ts`、`lib/analysis/capabilities.ts`、`lib/library/actions.ts`

- [ ] 迁移：`analysis_runs.kind` 的 CHECK 加入 `'enrich'`；`capabilities` 增加 `enriched_at timestamptz`、`open_questions jsonb NOT NULL DEFAULT '[]'::jsonb`、`suggestion_by text NOT NULL DEFAULT 'auto' CHECK (suggestion_by IN ('auto','human'))`；新增 `analysis_runs_one_active_enrich` 唯一索引（`kind='enrich' AND state IN ('queued','running')`）；`analysis_steps.step` 的 CHECK 加入 `'fetch'`。
- [ ] `editSuggestion` 同时写 `suggestion_by='human'`（现有 `type_by` 保持不变，两者语义分开：类型锁 vs 整次建议锁）。
- [ ] `cardSchema` 增加 `open_questions`（0–3 条，每条 ≤ 30 字）；`upsertCapability` 写入。
- [ ] reason prompt 按设计决定 5 改写摘要与信号的分工，并要求产出 `open_questions`。
- [ ] 测试：schema 边界、prompt 含新要求、editSuggestion 写标记、upsert 参数。

### Task 2: 权威来源抓取

**Files:** `lib/analysis/canonical.ts`(+test)

- [ ] `fetchCanonical(url, { fetch, signal })`：仅 http(s)；10 s 超时；≤ 512 KB；HTML 抽正文（复用既有 URL 素材处理，不要新写一套）；返回 `{ url, title, text, kind: 'page' }`。
- [ ] GitHub 仓库识别：`github.com/<owner>/<repo>` → 取 README（raw）与仓库元数据（star 数、许可证、最近推送时间），返回 `{ kind: 'repo', facts: {...}, text }`；无 token 时用匿名 API，429 / 失败即降级为普通页面抓取。
- [ ] 全部失败路径非致命：返回 null，调用方退回检索。
- [ ] 测试（注入 fetch）：普通页、GitHub 仓库、非 http(s)、超时、超大响应、404、429 降级。

### Task 3: 第二轮管线

**Files:** `lib/analysis/enrich.ts`(+test)、`lib/queue/runs.ts`、`lib/worker/tick.ts`、`scripts/worker.ts`、`lib/analysis/prompts.ts`

- [ ] `runEnrichment(deps, lease, signal)`：读卡 → `fetchCanonical`（记 `fetch` step）→ 针对 `open_questions` 做 ≤ 2 次 Tavily（记 `search` step）→ 一次 DeepSeek 重写（记 `reason` step），输出复用 `cardSchemaFor`，但**只取**模型字段。
- [ ] 写回：`summary`、`signals`、`playbook`、`source_facts`、`score`、`score_reason`、`open_questions`、`enriched_at = now()`；`type`/`usage`/`tags` 在 `suggestion_by='human'` 时保持原值，否则可更新；不动 verdict / status / progress / deep_analysis / notified_at。
- [ ] 预算 5 次 / 250k tokens、超时 3 分钟、租约 4 分钟；队列按 kind 取任务，worker 顺序：普通分析 → 补充调研 → 深度分析。
- [ ] 触发：`upsertCapability` 在结果为 keep 且 `enriched_at IS NULL` 时入队；`decide(keep)` 与 `editSuggestion`（结果 keep）同样入队；重复入队由唯一索引挡下。
- [ ] 测试：抓取成功 / 失败两条路径、人工字段不被覆盖、预算与超时、不清 notified_at、重复触发只排一个。

### Task 4: 展示调整

**Files:** `app/library/[id]/page.tsx`、`components/capability/capture-preview.tsx`、`components/capability/open-questions.tsx`(新)、两份字典

- [ ] 原始投递改为可折叠小图（默认折叠，标题「原始投递」），列表行缩略图不变。
- [ ] `open_questions` 非空时以「待核实」小字列表呈现，位置在价值信号之后。
- [ ] 卡片显示「已补充调研 · 时间」（`enriched_at`），与 🔬 已深挖并列但样式更轻。
- [ ] 测试：折叠默认态、待核实为空时不渲染、时间显示。

### Task 5: 存量补跑与上线

**Files:** `scripts/backfill-enrichment.ts`

- [ ] 对 `verdict='keep' AND status='active' AND enriched_at IS NULL` 的卡逐张入队（不是直接跑，交给 worker 按序消费，避免一次性打满 provider）；dry-run 默认列出将要补跑的卡与预计调用数。
- [ ] 生产：迁移 011 → 部署 → 先对 2–3 张卡验证效果（含 TOL-0045 这张）→ Human 认可后再全量入队。
- [ ] 记录成本：实际每卡调用数与 token 数，写入 `docs/m3_7-verification.md`。

## Self-review

- 病因两条都治：读第一手来源（T2/T3）、提示词分工（T1）。
- Human 决定全部落位：只给 keep 花钱（T3 触发条件）、重写模型字段保留人工字段（T1 标记 + T3 写回规则）、存量全量补跑（T5）。
- 风险：抓取外部页面（超时 / 大小 / 协议限制，失败降级）；第二轮覆盖人工内容（靠显式标记，不靠猜）；成本（每卡约 4 次，存量约 150 次，Human 已确认）；重复推送（不清 notified_at）。
