# Caphub v2 — M3.8（结构化摘要 + 版面美化）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 摘要能扫读（粗体标签 + 短句），版面向 munderdiffl.in 的风格靠拢。

**Spec:** `docs/superpowers/specs/2026-09-19-caphub-v2-design.md`；承接 M3.7（补充调研）。设计决定 2026-09-20 由 Human 选定。

## 背景

M3.7 让摘要写能力本身而不是分析过程，内容对了，但仍是一整段文字。Human 给出参考（munderdiffl.in 的截图）：一句引子，然后每条能力一行，**粗体标签 + 说明句**，行距舍得留白。

**时机**：存量 41 张卡只补跑了 3 张。摘要结构改完再跑剩下的，一次到位；顺序反过来要多花一百多次调用。因此本里程碑**先做，做完再继续补跑**（Human 2026-09-20 确认）。

## 设计决定（Human 已选定）

1. **摘要结构化**：模型输出改为
   - `summary`：一到两句引子（≤ 120 字），说清这是什么、解决什么；
   - `summary_points`：3–5 条 `{ label ≤ 8 字, text ≤ 60 字 }`，每条讲一个点。
   渲染成 `**标签。** 说明句`，web 与 Telegram 同一套结构。
2. **检索与向量**：全文检索与 embedding 的文本 = `summary` + 所有 `summary_points` 的 label/text 拼接，保证结构化后搜索能力不倒退。
3. **版面向参考风格靠拢**：标题更重更大、区块间距拉开、卡片圆角与描边统一、徽标改药丸形（琥珀实心 / 描边两种）、按钮样式统一。保持现有纸感配色（本来就接近），不换色系。
4. **列表行标签收敛**：每行最多显示 3 个标签，其余折成 `+N`；标签视觉弱化，不与评分、进度徽标抢眼。
5. **翻页按钮移到右下角**（现在在左下）。
6. **存量重跑**：M3.8 上线后，把已补充调研的 3 张卡的 `enriched_at` 清空，连同其余 38 张一起补跑（约 41 × 3 ≈ 123 次调用）。

## 需要 Human 授权

- 生产 Neon 执行迁移 012。
- 上线后全量补跑（约 123 次调用）。
- 临时 Neon branch 验证（建 / 删）。

## Global Constraints

沿用既有约定，另加：
- `summary` 与 `summary_points` 都由模型产出，受 schema 长度约束；人工改过的字段（`suggestion_by='human'` 的 type/usage/tags）仍不被补充调研覆盖。
- 渲染粗体：web 用语义标签，Telegram 用 `<b>`，两边都要走既有的转义与长度裁剪路径（不得拼裸 HTML）。
- 老数据兼容：`summary_points` 为空时按现状渲染整段摘要，不留空壳标题。
- 不改配色变量，只动排版与形状。

---

### Task 1: 结构化摘要（schema / prompt / 存储 / 检索）

**Files:** `lib/db/migrations/012_summary_points.sql`、`lib/analysis/card.ts`、`lib/analysis/prompts.ts`、`lib/analysis/capabilities.ts`、`lib/analysis/enrich.ts`、`lib/analysis/embedding.ts`、`lib/library/queries.ts`

- [ ] 迁移 012：`capabilities` 增加 `summary_points jsonb NOT NULL DEFAULT '[]'::jsonb`；全文检索的 `search` 生成列（见 001 的 `capability_search_text`）要把 points 的文本纳入——若生成列不便改，改为在该函数里读取新列并在迁移中重建索引，注意 IMMUTABLE 约束（001 踩过这个坑）。
- [ ] `cardSchema` 增加 `summary_points`（3–5 条，`label` ≤ 8 字、`text` ≤ 60 字），`summary` 上限收紧到 120 字；保持 `z.toJSONSchema` 可用。
- [ ] reason prompt 与 enrich prompt 同步改：引子写什么、每条要点写什么、禁止把整段话塞进一条 point。
- [ ] `upsertCapability` 与 enrich 写回都要写 `summary_points`。
- [ ] `embeddingText` 纳入 points 文本（设计决定 2）。
- [ ] 测试：schema 边界（2 条 / 6 条 / 超长 label）、prompt 含新要求、写库参数、embedding 文本包含 points、检索仍能命中只出现在 points 里的词。

### Task 2: 版面美化

**Files:** `app/globals.css`、`app/library/page.tsx`、`app/library/[id]/page.tsx`、`components/capability/*`、`lib/telegram/format.ts`

- [ ] 详情页与列表渲染结构化摘要：`**标签。** 说明` 一行一条，行距按正文 1.7，points 为空时回退整段摘要。
- [ ] Telegram 卡片同样按 `<b>标签</b> 说明` 分行；继续走字段级裁剪，不得在拼好的 HTML 上截断。
- [ ] 版面（设计决定 3）：标题字重与字号加强、区块垂直间距拉开、卡片圆角/描边统一、徽标改药丸形（琥珀实心用于强调，描边用于普通标记）、主次按钮样式统一。只动排版与形状，不动配色变量。
- [ ] 列表行标签最多 3 个 + `+N`，样式弱化（设计决定 4）。
- [ ] 翻页按钮移到右下角（设计决定 5）。
- [ ] 1440 / 390 截图前后对照，存 `.agent/screens/m3_8/`。

### Task 3: 验证与重跑

- [ ] 临时 Neon branch：应用 012，对 2–3 张卡跑补充调研，确认 points 正常产出与渲染，检索命中 points 内的词；截图走查。
- [ ] 生产：迁移 012 → 部署 → 清空那 3 张已补充调研卡的 `enriched_at` → 全量补跑 41 张 → 记录实际调用数与耗时。
- [ ] 写 `docs/m3_8-verification.md`。

## Self-review

- Human 的三条都落位：摘要排版（T1 + T2）、整体版面（T2）、翻页按钮与标签收敛（T2）。
- 顺序符合成本考量：结构先改，再一次性补跑。
- 风险：生成列改动踩 IMMUTABLE（T1 已点名）；老数据 points 为空的回退路径（T2）；Telegram 裁剪与粗体的配合（T2）。
