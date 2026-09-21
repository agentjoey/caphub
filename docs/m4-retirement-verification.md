# M4 子项目 3 — 旧版下线验证（2026-09-21）

范围：alljobs 仓库里的旧 Caphub 全面退役——停 worker、删代码、drop v1 schema、加外链、发布。
本文件记在 Caphub 仓库，因为退役的是 Caphub；实际改动发生在 alljobs
（`/Users/xtation/AgentWorks/GPT_Workspace/alljobs`）。

## 起点事实（与文档不符，查实后才动手）

alljobs 的 CLAUDE.md 称「旧版服务保持离线」，实际情况是旧 Caphub **仍在服役**：
`com.agentjoey.alljobs-caphub` worker 已连续运行 2 天 7 小时，alljobs 应用在 `127.0.0.1:3456` 监听，
Cloudflare Tunnel 通着，`/caphub` 对外可达。所以这不是清理死代码，是一次真正的生产下线。

另一个关键约束：`.worktrees/caphub-release` **是生产工作树，且与 alljobs 主应用共用**——
删它会把 alljobs 一起弄下线。整个过程中没有动过它，除了那一次获授权的发布。

## 执行顺序（按可逆性排）

| # | 动作 | 结果 |
|---|---|---|
| 1 | `launchctl bootout` 旧 worker，plist 移出 `~/Library/LaunchAgents` | 进程 22613 退出；plist 备份到 alljobs 的 `.agent/retired-launchd/`，可随时恢复 |
| 2 | Neon 快照 `before-drop-v1-caphub-schema` | 已创建（生产分支） |
| 3 | `DROP SCHEMA caphub CASCADE` | 已执行。事前核对：`caphub_v2` 对 v1 **零依赖**（无外键、无视图引用）；事后 v2 完好（82 卡 / 82 投递 / 196 次运行） |
| 4 | 删除旧代码 | 326 个文件、48718 行：`lib/caphub`、`app/caphub`、`app/api/caphub`、`app/captures`、`app/capabilities`、`app/reviews`、`components/caphub`、31 个 `scripts/caphub-*`、5 个 playwright 配置、13 个孤儿 e2e、本机 Postgres 的死配置 |
| 5 | 主导航加 Caphub 外链 | `NavItem.external` 渲染成普通 `<a>`，短路 `isNavItemCurrent`（外部产品永不标成"当前页"），`rel="noreferrer noopener"`；3 条测试盯住这两点 |
| 6 | 发布 | 生产树 detach 到 `7f28c0b`，`npm ci` + build，重载 `com.agentjoey.alljobs`；新 BUILD_ID `3IprGG7IEUB4NHGyodoCT` |

## 验证

| 检查 | 结果 |
|---|---|
| alljobs 全量测试 | 756 passed |
| lint | 0 error（67 个既有 warning 不变） |
| build | 成功，产物中已无 `/caphub`、`/captures`、`/capabilities`、`/reviews` 路由 |
| 线上 `/`、`/caphub`、`/captures`、`/capabilities`、`/reviews` | 200 / 404 / 404 / 404 / 404 |
| 首页导航 | 含 `href="https://caphub.agentjoey.ai" target="_blank" rel="noreferrer noopener"` |
| 新 Caphub | 不受影响（v2 代码从未引用 v1 schema） |

## 本机 Postgres 的处理（值得单独记一笔）

`deploy/com.agentjoey.alljobs-caphub-postgres.plist` 与 `deploy/caphub-postgres/*.conf.example`
描述的是一个**从未加载**的 launchd 任务，已随代码一并删除，`verify-deployment-config` 的相关断言同步收敛。

但本机 **确实有一个 Homebrew PostgreSQL 17 在 55432 上运行**——它装的是 **TalentVault 的七个库**
（`tv_rev2`、`tv_test` 等），与 Caphub 无关，**没有动它**。若当初只看 plist 名字就把它停掉，
会连带打断另一个项目。

## 回滚

代码回滚 = 生产树 checkout `a6c1918`、`npm ci`、rebuild、reload（那次的 BUILD_ID 是 `RhVEsnyByoj-HnofHebnd`）。
**但只回滚代码已经不能恢复一个能用的旧 Caphub**——v1 数据已删，必须先还原 Neon 快照
`before-drop-v1-caphub-schema`。这条提醒已写进 alljobs 的 `.agent/CURRENT.md`。

## 已知遗留

- alljobs 主分支的这次退役合并尚未 push 到远端（本地 `main` 领先 origin）。
- 一次排查中用 `pgrep -fl` 打出了生产进程的完整环境变量，`DEEPSEEK_API_KEY`、`MINIMAX_API_KEY`
  与带密码的 `CAPHUB_DATABASE_URL` 因此进入了会话记录。Human 已知悉，决定暂不轮换。
