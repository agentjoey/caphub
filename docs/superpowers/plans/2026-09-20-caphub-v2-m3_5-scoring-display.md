# Caphub v2 — M3.5（评分与来源事实 / 展示重构 / Telegram 卡片 / 参考自研进度）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 卡片能一眼看出「值不值、从哪来、怎么用、做到哪一步」。

**Spec:** `docs/superpowers/specs/2026-09-19-caphub-v2-design.md`（§4 schema、§5 分析、§6 web、§7 Telegram）。本文件的「设计决定」是增补，2026-09-20 由 Human 选定。

**Linear:** AJ-297（分析内容显示优化）、AJ-298（Telegram 卡片优化）、以及 Human 2026-09-20 提出的参考自研进度管理。AJ-295 / AJ-299 属于 M3.6，不在本期。

## 设计决定（Human 已选定）

1. **评分「两者都要」**：
   - **AI 价值评分** `score` 1–5（整数）+ `score_reason` 一句话。统一标准：成熟度、可复现性（有没有仓库/安装路径/提示词原文）、对 Joey 的适用度、与库内已有能力的互补性。4–5 分才建议直接整合，1–2 分通常该丢弃。
   - **客观来源事实** `source_facts`（结构化、可空）：仓库地址、star 数、最近更新时间、许可证、主页。只有当检索到的来源里**明确出现**才填，没看到就留空；每份事实带 `as_of` 日期。禁止推测（A/B/C spike 中模型编造过 star 数，prompt 里要显式禁止）。
2. **展示顺序**（web 与 Telegram 一致）：一句话总结 → 场景 / 用法 / 评分 → 价值信号 → 怎么用（playbook）→ 来源事实 → 详情（折叠的分析步骤）。
3. **详情页重做**：两栏（窄屏单栏）；左主栏按上面的顺序分区块，右侧为截图、来源事实表、操作。评分以徽标形式挨着标题。
4. **Telegram 卡片**：分段落（建议 / 总结 / 场景标签 / 评分），段间空行；按钮文案加图标前缀提高可辨识度（`✅ 保留`、`🗑 丢弃`、`♻️ 重跑分析`、`🔗 去 web`）。Telegram 不允许自定义按钮配色，对比度只能靠文案与图标改善。
5. **参考自研进度**：卡片加 `progress`（`todo` 未处理 / `planned` 已排期 / `building` 自研中 / `done` 已完成 / `dropped` 放弃，默认 todo）与 `progress_link`（外链，可空）、`progress_at`。**只对 `usage = 'reference'` 的卡生效并展示**；`integrate` 卡不显示进度。
6. **不在本期**：与库内比对、失效 / 被替代状态、深度分析（均为 M3.6）；自动建 backlog、提醒、工时统计。

## 需要 Human 授权

- 生产 Neon 执行迁移 007。
- 真实模型调用：为存量 13 张卡回填评分与来源事实（DeepSeek，每卡 1 次，一次性）。
- 临时 Neon branch 验证（建 / 删）。

## Global Constraints

沿用既有约定，另加：
- `score` 为 1–5 整数，`NULL` 表示尚未评分（存量卡回填前）；UI 与 Telegram 在为空时不显示评分，不显示 0 分。
- `source_facts` 字段全部可空，禁止模型推测；未检索到即留空。
- 进度只对 `usage='reference'` 有意义；其它 usage 的卡不读也不写该字段。
- Telegram callback_data ≤ 64 字节（新增进度动作沿用既有编解码并扩充 action 白名单）。
- 所有写操作保持 `date_trunc('milliseconds', updated_at)` 乐观锁口径；进度更新**不**改 `verdict`，但会更新 `updated_at`（会触发重新计算向量，可接受）。
- UI 文案走 zh/en 字典；Telegram 文案中文。

---

### Task 1: 迁移 007 + 卡片 schema 增加评分与来源事实

**Files:** `lib/db/migrations/007_score_progress.sql`、`lib/analysis/card.ts`、`lib/analysis/prompts.ts`、`lib/analysis/capabilities.ts`、`lib/analysis/scenarios.ts`(cardSchemaFor)

- [ ] 迁移：
```sql
ALTER TABLE caphub_v2.capabilities
  ADD COLUMN score integer CHECK (score BETWEEN 1 AND 5),
  ADD COLUMN score_reason text,
  ADD COLUMN source_facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN progress text NOT NULL DEFAULT 'todo'
    CHECK (progress IN ('todo','planned','building','done','dropped')),
  ADD COLUMN progress_link text,
  ADD COLUMN progress_at timestamptz;
CREATE INDEX capabilities_progress_idx ON caphub_v2.capabilities (progress)
  WHERE usage = 'reference' AND deleted_at IS NULL;
```
- [ ] `cardSchema` / `cardSchemaFor` 增加 `score`（1–5 整数）、`score_reason`（≤ 80 字）、`source_facts`（对象，字段：`repo_url`、`stars`、`last_update`、`license`、`homepage`，均 nullable，附 `as_of`）。保持 `z.toJSONSchema` 可用（既有回归测试）。
- [ ] reason prompt 增加评分标准与「事实只能来自检索结果，未见到就留空，禁止推测 star 数与更新时间」的约束。
- [ ] `upsertCapability` 写入三个新列；人工裁决不覆盖评分。
- [ ] 测试：schema 边界（0 / 6 分、缺字段）、prompt 含评分标准、upsert SQL 参数。

### Task 2: 存量卡回填评分与来源事实

**Files:** `scripts/backfill-score.ts`

- [ ] 对 `score IS NULL` 且未删除的卡，用 DeepSeek 单次结构化调用，输入标题 / 摘要 / 价值信号 / playbook / 标签 / 已有 source_url，输出 `{score, score_reason, source_facts}`；只更新这三列，不动 `updated_at`。
- [ ] dry-run 默认，`--apply` 写入；沿用 backfill-scenarios.ts 的 bootstrap 与日志风格。
- [ ] 无法判断来源事实时留空，不得编造。

### Task 3: 详情页重构 + 进度控件

**Files:** `app/library/[id]/page.tsx`、`app/library/[id]/detail-actions.tsx`、新增 `components/capability/score-badge.tsx`、`components/capability/source-facts.tsx`、`components/capability/progress-control.tsx`、`lib/library/actions.ts`、`app/actions.ts`、`app/globals.css`

- [ ] 按设计决定 2 的顺序重排详情页区块；评分徽标（1–5，带 `score_reason` 作为 title 属性）置于标题旁。
- [ ] 来源事实表：仓库地址（可点）、star 数、最近更新、许可证、主页、`as_of`；全空时整块不渲染。
- [ ] 进度控件（仅 `usage='reference'`）：五个状态按钮 + 链接输入 + 保存；走新的 server action `setProgress(pool, {id, expectedUpdatedAt, progress, link})`，复用乐观锁与 `ActionResult`；链接校验为 http(s) 或空。
- [ ] i18n：zh/en 两套字典补齐新文案。
- [ ] 测试：区块顺序与条件渲染、进度控件交互与冲突提示、setProgress 的 SQL 与校验。

### Task 4: 能力库列表、统计与筛选

**Files:** `lib/library/queries.ts`、`lib/library/search-params.ts`、`app/library/page.tsx`、`app/library/library-filters.tsx`

- [ ] 列表行显示评分（无评分不显示）；参考自研卡显示进度徽标，`done` 弱化。
- [ ] 统计条增加「待自研」块：`usage='reference' AND progress IN ('todo','planned')` 的 keep 卡数量，可点筛选。
- [ ] 新增筛选参数 `progress`（多选，沿用 type 的写法）。
- [ ] 排序：默认仍按 `updated_at`；搜索时评分参与轻微加权（`+0.05 * (score - 3)`，仅在有评分时），避免高分卡被埋没。
- [ ] 测试：统计 SQL、筛选参数解析与 SQL、加权表达式、无评分卡不受影响。

### Task 5: Telegram 卡片与 /todo

**Files:** `lib/telegram/format.ts`、`lib/telegram/commands.ts`、`lib/telegram/router.ts`、`lib/telegram/decide.ts`

- [ ] 卡片重排：`建议：…`、空行、`总结：…`、空行、`场景 / 标签`、`评分：★4/5 · 理由`；保持 HTML 安全裁剪逻辑（字段先裁剪再拼装）。
- [ ] 按钮文案加图标前缀（✅ / 🗑 / ♻️ / 🔗）。
- [ ] `/todo`：列出 `usage='reference'` 且 `progress IN ('todo','planned','building')` 的 keep 卡（≤ 5），每条带按钮 `开始自研` / `已完成` / `放弃`；更多则给 web 链接。
- [ ] callback 动作扩充：`pb`（building）/ `pd`（done）/ `px`（dropped），复用编解码与 64 字节校验；沿用乐观锁与「已在别处处理」冲突处理；成功后原地改写消息并移除按钮。
- [ ] `syncCommands` 增加 `/todo` 描述。
- [ ] 测试：新卡片文案（含评分、无评分两种）、按钮文案、/todo 列表与空态、三个新动作的成功 / 冲突 / 未找到路径。

### Task 6: 验证与上线

- [ ] 临时 Neon branch：应用 007、跑回填脚本、浏览器走查（详情页新版式、进度切换与冲突、统计与筛选、搜索加权）、1440/390 截图。
- [ ] 生产：迁移 007 → 推送 → 回填 → Telegram 走查（卡片版式、按钮、/todo 三个动作）。
- [ ] 写 `docs/m3_5-verification.md`，截图放 `.agent/screens/m3_5/`。

## Self-review

- AJ-297 三条：结构化来源与评分（T1/T2/T3）、顺序调整（T3/T5）、详情页 UI 重做（T3）。
- AJ-298 两条：文字分段与评分（T5）、按钮可辨识度（T5，受 Telegram 限制只能靠文案与图标）。
- 参考自研进度：字段（T1）、web（T3/T4）、Telegram（T5）。
- 风险：模型编造来源事实（prompt 显式禁止 + 允许留空 + 事实带 as_of）；进度更新触发重新向量化（可接受，embed tick 自行处理）；Telegram 按钮配色无法自定义（已在设计里说明）。
