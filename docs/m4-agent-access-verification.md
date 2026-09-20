# M4 子项目 1 — Agent 接入验证（AJ-296，2026-09-21）

范围：远程 MCP 端点 `POST /api/mcp`，Cloudflare Access service token 鉴权，五个只读工具 + 两个写工具，
迁移 013（`build_notes`），详情页笔记展示，接入文档。

计划：`docs/superpowers/plans/2026-09-21-caphub-v2-agent-access.md`；
设计：`docs/superpowers/specs/2026-09-21-caphub-v2-agent-access-design.md`。

环境：生产（Railway `web` + `worker`，Neon `caphub`）。合并提交 `738b768`，随后 `1d43424`。

## 上线

| 步骤 | 结果 |
|---|---|
| 临时 Neon branch 验证迁移 013（跑两遍） | 第一遍 applied，第二遍空；验证后删除 branch |
| 生产执行迁移 013（worker 空闲时） | applied；列存在、GIN 索引重建、`capability_search_text` 只剩一个重载、82 张卡的全文向量全部重建 |
| 合并 `m4-agent-access` → main（`738b768`），web + worker 部署 | SUCCESS |
| 拒绝日志补丁（`1d43424`） | SUCCESS |
| Human 在 Cloudflare Access 建 service token `caphub-mcp` + Service Auth 策略 `caphub-agent-access` | 完成 |
| Human 在 Railway `web` 设 `CF_ACCESS_SERVICE_TOKEN_CN` | 完成 |

## 临时 branch 上的迁移验证

- 只写在 `build_notes` 里的中文短语：**全文检索搜不到**（`simple` 配置把整串中文切成一个 token），
  **ILIKE 搜得到**；笔记里的 ASCII 词（`claude`）全文检索搜得到。这实测确认了「ILIKE 那条腿才是中文
  搜索的承重墙」——M3.8 曾经漏过一次。
- 应用层 `listLibrary("鲜为人知")` → 1 条命中；反向对照 0 条；`getCapabilityDetail` 返回 `buildNotes`。
- `appendBuildNote` 用新鲜锁成功；用同一把（已过期的）锁再写一次被拒 `CONFLICT`，没有覆盖；
  追加顺序保持最旧在前；`resolveSerial("SKL-9999")` 返回 null。

## 真机验收（Human 用 service token 直连生产端点）

| 检查 | 结果 |
|---|---|
| 无凭据 / 伪造 header 请求 | 302 跳 Access 登录（边缘就拦住，请求没到应用） |
| 带正确 header、未配白名单变量时 | 401（应用侧 fail closed） |
| 配好白名单后 `tools/list` | 7 个工具齐全 |
| `search_capabilities("网页动效", limit 3)` | total 14，命中 SKL-0031 / SKL-0055 / TOL-0053 |
| `get_capability("SKL-0031")` | 标题、深度分析正常返回 |
| `set_build_progress(serial, "planned")` | **拒绝**：只能是 building / done / dropped |
| `set_build_progress("TOL-0009", "building", link, note)` | 写入成功 |

写回后库内核对：进度 `building`、链接指向 `agentjoey/pactify`、笔记 1 条（作者 `claude`）；
搜「已可跑通」命中 TOL-0009（走 ILIKE）；待自研口径 28 张**不含** TOL-0009（`building` 不在口径内）。
Human 在 web 详情页确认「自研进度」与「自研笔记」两个区块显示正确。

TOL-0009 是参考对象（Munder Difflin），自研实现是 pactify——这正是「参考自研」这条链路的用法：
卡片记外部能力，`progress_link` 指向自己的实现。

## 过程中修掉的问题

| 问题 | 影响 | 修复 |
|---|---|---|
| 字面量 `null` 请求体在 try 外解构，返 500 而不是 JSON-RPC 错误 | 违反「坏输入绝不返 500」的约束；终审评审实际复现 | 解构前拒绝一切非普通对象，返 -32600（`2377f14`） |
| 只有 `notifications/initialized` 被当作通知，其余通知会收到响应 | 真实客户端会发 `notifications/cancelled`，给通知回响应是协议违规 | 按 `id` 缺失 + `notifications/` 前缀通用处理（`2377f14`） |
| `list_to_build` 的描述说包含「正在自建」，查询却刻意排除 `building` | 描述原样发给模型；agent 标记自研中后再查会发现卡片消失，可能误判写失败 | 改描述，不改查询（`122c801`） |
| schema 对外宣称上限 25，底层查询固定 `LIMIT 20` 且无翻页 | 第 21–25 条任何调用都拿不到 | 对外上限降到 `PAGE_SIZE`（`122c801`） |
| 文档把三段客户端配置摆成同等可信 | 只有 Claude Code 那段能在本仓库验证 | 加一句说明（`122c801`） |
| 被拒绝的请求不留任何日志 | 配置 service token 时无从判断是哪一道检查拒的，只能靠猜 | 每种拒绝记一个原因代码 + 路径，绝不记 JWT / header / `common_name`；带一条断言日志不含凭据的测试（`1d43424`） |

## 安全边界（终审逐条追过）

- 四种身份 × 路径变体（尾斜杠、大小写、查询串、前缀）全部 fail closed。
- 浏览器身份（`email`）与机器身份（`common_name`）互不串用：service token 打普通页面同样 401。
- agent 够不到丢弃卡、退役卡、软删卡，拿不到存储键或图片；只能写 `progress` / `progress_link` / `build_notes`。
- 未配 `CF_ACCESS_SERVICE_TOKEN_CN` 时 `/api/mcp` 一律 401，不退化成「验签通过即放行」。

## 已知遗留

- `build_notes` 没有条数上限：单条 2000 字，但累计超过约 1MB（约 500 条）后 `to_tsvector` 会报错，
  那张卡将无法再写入。离得很远，但该补一个条数上限。
- 工具内部抛出的真实异常（如 pg 错误）会以业务错误的形式回给模型，原始错误文本原样透出；
  单租户 + token 保护下可接受，但模型可能把它当成「不该重试的拒绝」。
- `CARD_COLUMNS` 为每一行列表都取出 `build_notes`，而 `CapabilityRow` 并不声明它——纯粹是多余的传输量。
- `lib/mcp` 里有几处硬编码的中文错误文案，没有走字典。
- 无 GET/SSE：若某个客户端要求 SSE 传输则用不了（退路是加一个本地 stdio 代理，本期未做）。
- Access service token 有有效期，到期需轮换，且各客户端配置都要跟着改。
