# M3.8 verification (2026-09-21)

范围：结构化摘要（`summary` 引子 + `summary_points` 要点）与版面美化，参考 Human 给的
munderdiffl.in。计划见 `docs/superpowers/plans/2026-09-20-caphub-v2-m3_8-presentation.md`。

环境：生产（Railway `web` + `worker`，Neon `caphub`），迁移 012 已应用。

## 上线

| 步骤 | 结果 |
|---|---|
| 迁移 012（`summary_points jsonb`，用 5 参数 IMMUTABLE 的 `capability_search_text` 重建生成列 `search`，重建 GIN 索引） | applied |
| Task 1 结构化摘要 schema / prompt / 存储 / 检索（`397ca3a`、修复 `8d7a37f`） | SUCCESS |
| Task 2 版面（结构化摘要渲染、药丸徽标、间距、标签收敛、翻页移右下）（`6c6cdc7`） | SUCCESS |
| 终审修复（`6c547fb`） | SUCCESS |
| 全量重跑补充调研（清空 `enriched_at` 后 43 张） | 43/43 |

重跑后数据：入库有效卡 43 张，全部已补充调研，平均 4.88 条要点、摘要引子平均 93 字，4 张已做深度分析。

## Human 走查结果

通过（2026-09-21，web）：摘要版面、中文搜索、标签与翻页、Telegram 卡片编辑均正常。
深度分析页面按当前版本定稿。

## 走查 / 终审中修掉的问题

| 问题 | 影响 | 修复 |
|---|---|---|
| `summary_points` 的 schema 上限等于提示词目标值 | 一个字超出就废掉整轮（只有两次尝试） | 上限放到 12 / 90（提示词仍是 8 / 60）（`8d7a37f`） |
| 中文检索没覆盖 `summary_points` | `simple` 分词把整串中文切成一个 token，中文搜索实际靠的是 ILIKE 那条腿；结构化之后正文搬进了 points，中文搜索会倒退 | ILIKE 腿加上 `summary_points::text`；在 123 次调用的全量重跑之前修掉（`6c547fb`） |
| 药丸按钮样式与重复的来源链接 | 版面细节 | `6c547fb` |

## 已知遗留

- 搜纯数字（如 `031`）不会命中编号 `SKL-0031`：裸数字按设计不做编号查，编号以整数存库、`SKL-0031` 是应用层拼出来的，文本检索也匹配不到。带前缀（`skl31`、`SKL-0031`）或 `#31` 可以。Human 2026-09-21 裁定维持现状。
- 本轮未产出脚本截图，以 Human 真机走查为准。
