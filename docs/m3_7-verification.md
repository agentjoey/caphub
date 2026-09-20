# M3.7 verification (2026-09-20)

范围：入库补充调研（第二轮）——卡片写能力本身而不是分析过程，原始截图退居线索。
计划见 `docs/superpowers/plans/2026-09-20-caphub-v2-m3_7-enrichment.md`。

环境：生产（Railway `web` + `worker`，Neon `caphub`），迁移 011 已应用。

## 上线

| 步骤 | 结果 |
|---|---|
| 迁移 011（`kind='enrich'`、`step='fetch'`、`enriched_at`、`open_questions`、`suggestion_by`、第三个唯一索引） | applied |
| Task 1 迁移与标记（`ad909f0`） | SUCCESS |
| Task 2 权威来源抓取 `canonical.ts`（含 SSRF 守卫）（`3d7600d` 前置） | SUCCESS |
| Task 3 第二轮管线 `enrich.ts`（`3d7600d`、修复 `1aa98c7`） | SUCCESS |
| Task 4 展示调整（原始投递折叠、待核实、已补充调研标记）（`8e2d8ac`） | SUCCESS |
| Task 5 存量补跑脚本（`f666442`）、终审修复（`35c20d0`） | SUCCESS |

## 存量补跑

| 批次 | 入队 | 成功 | 失败 |
|---|---|---|---|
| 首轮 | 43 | 37 | 6（5 × `INVALID_OUTPUT`，1 × `UNAVAILABLE`） |
| 重跑失败项 | 6 | 6 | 0 |
| 合计 | 43 | **43** | 0 |

实际每卡约 3 次调用（抓取不计），不是计划里估的 4 次——这个差值我在过程中向 Human 更正过。

## 走查 / 终审中修掉的问题

| 问题 | 影响 | 修复 |
|---|---|---|
| 人工编辑守卫在装载时读取（最长可能已经 3 分钟前） | 第二轮跑到一半时点「改建议」会被静默覆盖 | 守卫下沉进 UPDATE：`type`/`usage`/`tags` 用 `CASE WHEN suggestion_by = 'human'` 保留（`1aa98c7`） |
| 提交后的入队写在回滚的 try 里 | 已提交的写入被报成失败，并推送一条假的「分析失败」 | 每个入队各自 try/catch（`1aa98c7`） |
| 重跑分析会把便宜的旧摘要永久留下 | 入队条件写成 `enriched_at IS NULL` | 裁定：重跑必须重新补充调研（`1aa98c7`） |
| 补充调研完成后 Telegram 上看不到 | 第二轮不清 `notified_at`，也就不再推送 | 裁定：成功的补充调研就地编辑已存在的那条消息（编辑不触发通知，`notified_at` 不动）（`35c20d0`） |
| 什么都没查到也照样重写、还盖上「已补充调研」 | 卡片内容变差却显示更权威 | 加按标题的兜底检索；确实无所得时跳过重写，`enriched_at` 保持 NULL（`35c20d0`） |

## 已知遗留

- 补充调研失败只出现在 worker 日志里，卡片上没有标记。
- `suggestion_by` 只保护第二轮，不保护第一轮的「重跑分析」覆盖 `usage`/`tags`。
- 本轮未产出脚本截图，以 Human 真机走查为准。
