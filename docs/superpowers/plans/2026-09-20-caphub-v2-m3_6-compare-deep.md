# Caphub v2 — M3.6（库内比对与有效性状态 / 能力深度分析）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 新卡进来能告诉我「库里已经有了 / 这个更强 / 互补」，旧卡能被标为失效；对看中的能力可以手工触发一次彻底的深挖。

**Spec:** `docs/superpowers/specs/2026-09-19-caphub-v2-design.md`。本文件的「设计决定」是增补，2026-09-20 由 Human 选定。

**Linear:** AJ-295（新能力与库内比对）、AJ-299（能力深度分析）。

## 设计决定（Human 已选定）

1. **比对范围**：用已有的 pgvector 向量取全库语义最接近的 5 张（不限类型，排除自身与已删除），交给 reason 步骤判断关系。跨类型的替代关系（一个 tool 替代一套 skill）也要能发现。
2. **只提示，不自动生效**：模型给出关系与理由，**不动旧卡**。Human 在详情页或 Telegram 确认后，旧卡才被标记。
3. **有效性状态**：`active`（有效，默认）/ `deprecated`（失效）/ `superseded`（被替代，记录替代者）。能力库**默认隐藏**非 active 的卡，提供「含失效」开关筛选出来；记录永远保留，不删除。手工也能直接把一张卡置为失效。
4. **深度分析**：Human 手工触发，彻底档（预算 8 次调用 / 400k tokens）：先由 DeepSeek 规划 4–6 条检索式 → Tavily 多路检索（官方文档、仓库、讨论区、对比文章）→ DeepSeek 分两段综合。产出结构化的架构、技术实现、适用场景、真实案例、用户反馈与风险，存为详情页独立版块。web 与 Telegram 都能触发，完成后推送。
5. **不在本期**：自动替代、定期重新比对、深度分析的自动刷新、把深度分析结果并入摘要或评分。

## 需要 Human 授权

- 生产 Neon 执行迁移 010。
- 真实调用：深度分析每次 6–8 次调用（Tavily + DeepSeek），由 Human 手工触发；比对本身不增加调用（并入既有 reason 步骤）。
- 临时 Neon branch 验证（建 / 删）。

## Global Constraints

沿用既有约定，另加：
- 比对与深度分析都不得编造事实：比对只能引用「候选相似卡」里真实给出的编号；深度分析的每条结论要能对上它引用的来源，来源为空就说不知道。
- 状态写操作走既有 `date_trunc('milliseconds', updated_at)` 乐观锁；标记旧卡失效是对**另一张卡**的写操作，需要它自己的锁令牌。
- 深度分析是独立的 run（`analysis_runs.kind='deep'`），与普通分析共用队列与租约，但有自己的预算；同一张卡同时只能有一个进行中的深度分析。
- 深度分析结果与卡片正文分开存储，重跑普通分析不清除它，但要记录它依据的是哪一版卡片（`deep_analysis_at` + 当时的 `updated_at`）。
- Telegram 文案中文；UI 文案走 zh/en 字典；不显示内部 id（用编号）。

---

### Task 1: 迁移 010 + 比对字段进入分析

**Files:** `lib/db/migrations/010_status_overlap_deep.sql`、`lib/analysis/card.ts`、`lib/analysis/prompts.ts`、`lib/analysis/similar.ts`、`lib/analysis/pipeline.ts`、`lib/analysis/capabilities.ts`

- [ ] 迁移：
```sql
ALTER TABLE caphub_v2.capabilities
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','deprecated','superseded')),
  ADD COLUMN superseded_by text REFERENCES caphub_v2.capabilities(id),
  ADD COLUMN status_at timestamptz,
  ADD COLUMN status_note text,
  ADD COLUMN overlap jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN deep_analysis jsonb,
  ADD COLUMN deep_analysis_at timestamptz,
  ADD COLUMN deep_analysis_of timestamptz;
ALTER TABLE caphub_v2.analysis_runs
  ADD COLUMN kind text NOT NULL DEFAULT 'analysis'
    CHECK (kind IN ('analysis','deep'));
CREATE INDEX capabilities_status_idx ON caphub_v2.capabilities (status)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX analysis_runs_one_active_deep
  ON caphub_v2.analysis_runs (capture_id)
  WHERE kind = 'deep' AND state IN ('queued','running');
```
  （`analysis_steps.step` 的 CHECK 需要加入 `plan` 与 `synthesize`，同一迁移里改。既有 `analysis_runs_one_active` 唯一索引只约束普通分析，确认它带 `kind='analysis'` 条件或改成带该条件。）
- [ ] 候选相似卡改用向量：`similarByEmbedding(db, capabilityId | embedding, limit=5)`，排除自身、已删除、非 active；返回编号、标题、类型、一句话摘要、标签。没有向量时回退到既有 `similar.ts` 的文本相似。
- [ ] `cardSchema` 增加 `overlap`：`{ relation: "none" | "duplicate" | "upgrade" | "superseded" | "complement", target: string | null, reason: string ≤ 80 }`。`target` 只能是候选列表里给出的编号（如 `TOL-0009`），否则视为无效输出走重试；`relation="none"` 时 target 必须为 null。
- [ ] reason prompt：把候选卡按 `编号 · 标题 · 类型 · 一句话` 列出，要求判断本卡与其中最相关一张的关系（重复 / 本卡是升级 / 本卡被对方替代 / 互补 / 无关），并给 ≤ 80 字理由；明确禁止引用列表以外的编号。
- [ ] `upsertCapability` 写 `overlap`；重跑覆盖，人工状态不受影响。
- [ ] 测试：schema 边界（target 不在候选里、relation=none 带 target）、prompt 含候选列表、向量候选 SQL、upsert 参数。

### Task 2: 有效性状态（web）

**Files:** `lib/library/actions.ts`、`app/actions.ts`、`lib/library/queries.ts`、`lib/library/search-params.ts`、`app/library/page.tsx`、`app/library/[id]/page.tsx`、新增 `components/capability/overlap-notice.tsx`、`components/capability/status-control.tsx`

- [ ] `setStatus(pool, { id, expectedUpdatedAt, status, supersededBy, note }, locale)`：写 `status`、`superseded_by`、`status_at`、`status_note`，bump `updated_at`；`superseded_by` 只在 `status='superseded'` 时允许且必须指向一张存在、未删除、非自身的卡；其余组合走 INVALID。
- [ ] 详情页：
  - 顶部状态徽标（失效 / 被 TOL-0009 替代，可点跳转）；
  - 比对提示块（overlap.relation ≠ none 时）：「疑似与 TOL-0009 重复 · 理由」+ 两个按钮：`把 TOL-0009 标为被本卡替代`（写**对方**的状态，需要读对方的锁令牌）、`忽略`（把本卡 overlap 置为 none，不动对方）；
  - 状态控件：置为失效 / 恢复有效 / 标记被替代（选一张卡：用编号输入，校验存在）。
- [ ] 能力库：默认 `status='active'`；新增 `includeRetired` 开关（与「已丢弃」并列），列表行对非 active 卡显示状态徽标并弱化。
- [ ] 统计：各类型计数与「待自研」只算 active。
- [ ] i18n 两份字典补齐。
- [ ] 测试：setStatus 的合法/非法组合与锁冲突、默认过滤、开关筛选、忽略 overlap、对方卡被标记后详情页互链。

### Task 3: 深度分析管线（worker）

**Files:** `lib/analysis/deep.ts`(+test)、`lib/analysis/prompts.ts`、`lib/analysis/budget.ts`、`lib/worker/tick.ts`、`lib/queue/runs.ts`、`scripts/worker.ts`

- [ ] `runDeepAnalysis(deps, lease, signal)`：
  1. plan：DeepSeek 结构化输出 4–6 条检索式（覆盖官方文档 / 仓库 / 讨论区与口碑 / 同类对比），记为 `plan` step；
  2. search：逐条 Tavily 检索（≤ 6 次），每次记 `search` step，内容截断沿用既有上限；
  3. synthesize：DeepSeek 两段综合（先事实归并，再成文），记 `synthesize` step，输出 `DeepAnalysis`：`architecture`、`implementation`、`use_cases[]`、`cases[]`（真实案例，带来源）、`feedback`（口碑与争议）、`risks[]`、`sources[]`（标题 + 链接）。
- [ ] 预算：8 次调用 / 400k tokens，超出即失败并记原因；单次运行整体超时 5 分钟。
- [ ] 结论必须能对上来源：`cases`/`feedback` 的每一项要么带 `sources[]` 下标，要么明说「未找到公开案例」。prompt 里写死这条。
- [ ] 队列：`RunQueue` 支持按 `kind` 取任务；worker tick 先处理普通分析，再处理深度分析（同一租约机制，深度分析租约 6 分钟）。
- [ ] 完成后写 `capabilities.deep_analysis`、`deep_analysis_at = now()`、`deep_analysis_of = 卡片当时的 updated_at`，不动 `updated_at` 本身；失败只记 run 状态与错误。
- [ ] 测试：plan/search/synthesize 三步的假 provider 流程、预算超限、超时、来源对不上时的重试、写库参数。

### Task 4: 深度分析的触发与展示

**Files:** `lib/library/actions.ts`、`app/actions.ts`、`app/library/[id]/page.tsx`、新增 `components/capability/deep-analysis.tsx`、`lib/telegram/{format,decide,router,notify}.ts`

- [ ] `requestDeepAnalysis(pool, { captureId }, locale)`：仅对 `verdict='keep'` 且未删除的卡；已有进行中的深度分析 → CONFLICT（沿用唯一索引 23505 处理）；入队 `kind='deep'`。
- [ ] 详情页新增「深度分析」版块：未生成时显示按钮与一句成本说明（约 6–8 次检索与分析调用）；进行中显示状态；失败显示原因与重试；完成后按 架构 / 技术实现 / 适用场景 / 案例 / 口碑与争议 / 风险 / 来源 分区渲染，并标注「依据 X 时的卡片内容」。
- [ ] Telegram：卡片增加 `🔬 深度分析` 按钮（callback `da`），触发后回执「已排队」；完成后推送一条摘要（架构一句话 + 适用场景 + 风险要点 + 详情链接），全文只在 web 看。
- [ ] `/help` 与命令说明同步更新。
- [ ] 测试：触发的合法性与冲突、UI 三态渲染、Telegram 按钮与推送文案、深度分析结果为空字段时的降级渲染。

### Task 5: 验证与上线

- [ ] 临时 Neon branch：应用 010，对 2–3 张真实卡跑深度分析（真实调用，需授权），走查比对提示、确认流程、状态筛选、深度分析三态与 Telegram 推送；1440/390 截图存 `.agent/screens/m3_6/`。
- [ ] 生产：迁移 010 → 推送 → Human 真机走查 → 记录 `docs/m3_6-verification.md`。
- [ ] 观察一轮成本：记录深度分析单次实际调用数与 token 数，写进验证文档。

## Self-review

- AJ-295：向量候选（T1）、关系判定与 schema（T1）、人工确认与状态（T2）、默认隐藏与筛选（T2）。
- AJ-299：管线与预算（T3）、触发与展示、Telegram（T4）、成本记录（T5）。
- 风险：模型引用不存在的编号（schema 限定候选集 + 重试）；深度分析成本失控（预算 + 唯一索引 + 手工触发）；状态写的是另一张卡（T2 明确要求读对方锁令牌）；`analysis_runs_one_active` 若未带 `kind` 条件会挡住深度分析入队（T1 明确检查）。
