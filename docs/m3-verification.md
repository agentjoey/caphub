# M3 verification (2026-09-20)

环境：生产（Railway `web` + `worker`，Neon `caphub`），迁移 006 已应用，`TELEGRAM_ENABLED=true`，bot `Mario | alljobs`（@supermario_agent_bot，id 8769790676）。走查由 Human 在 iPhone 上真机完成。

## 上线步骤（按 docs/deploy.md 的 M3 小节执行）

| 步骤 | 结果 |
|---|---|
| 迁移 006（telegram_state、analysis_runs.notified_at） | applied |
| 合并 m3-telegram → main（188d94d），推送 | web / worker 均 SUCCESS |
| `TELEGRAM_ENABLED=true` | worker 启动日志 `telegram="getMe" username="supermario_agent_bot"` |
| `setMyCommands` | /help /find /add /pending /stats 已写入 |
| 翻开关前确认存量 telegram 来源 capture 数 | 0（无补发风暴） |

## 走查结果（Human，全部通过）

| 检查 | 结果 |
|---|---|
| `/help` 显示用法说明 | PASS |
| 发图片 → 回执「已收到，分析中…」→ 同一条消息改写成结果卡 | PASS |
| 待决卡按钮 保留 → 按钮消失，消息变为保留后的卡 | PASS |
| 直接打字「配音」→ 返回 4 条命中（SKL-0006 / 0007 / 0002 / 0008），标题为可点链接 | PASS |
| `SKL-3` 精确定位 | PASS |
| `/stats`、`/pending` | PASS |
| 发链接投递、`/add 文字`投递 | PASS |
| 自动保留卡片推送（含类型 / 用法 / 场景 / 标签 / 详情链接） | PASS |
| 分析失败推送（❌ 分析失败 · 模型输出不合规（已重试）） | PASS |
| 重跑分析 → 消息改写为「已重新排队，分析中…」→ 新结果回填同一条消息 | PASS（修复后复验） |

## 走查中发现并修复的缺陷

**`/pending` 列出的 web 来源卡片，点「重跑分析」后消息永远停在「已重新排队，分析中…」。**
`runNotifyTick` 的两条选取语句都带 `c.source = 'telegram'`，因此 web 投递的 capture 即使正被 Human 在 Telegram 里跟进，分析结果也不会推回去。保留 / 丢弃 不受影响（由 decide.ts 当场改写消息）。

修复（46fbd99）：选取条件改为「该 capture 存有可更新的 Telegram 消息」（`telegram_chat_id`/`telegram_message_id` 均非空）；`/pending` 发出的每条卡片消息、以及重跑按钮所在的消息，都会把位置记到对应 capture 上。Telegram 投递的卡因回执已记录位置，行为不变。

修复前已经停住的旧消息不会自动恢复（当时没有记录位置），重新 `/pending` 即可。

## 已知遗留（不阻塞）

- 滚动部署时新旧 worker 会短暂同时轮询，Telegram 返回几秒 409，退避后自动恢复。
- 图片 caption 已被识别但未使用。
- `capMessageSafely` 依赖「本模块的标记不跨行」这一隐含约定（见 format.ts 注释）；当前字段裁剪逻辑保证走不到那条分支。
- 较早的、已被新失败运行取代的 failed run 不会补推（代码内有 TODO）。
