# Caphub v2 — Agent 接入设计（AJ-296）

**状态**：2026-09-21 由 Human 逐节确认。承接 `docs/superpowers/specs/2026-09-19-caphub-v2-design.md`，
是 M4 三个子项目中的第一个（另两个是 Obsidian 投影、旧版下线收尾，各自另写）。

## 1. 目标

让 Joey 的其他 agent（claude / codex / opencode / kimicode 等）在干活时：

1. **查**——按自然语言描述找到库里相关的能力，读到足够动手的细节；
2. **回写**——把"建议自研"的能力做完之后，把进度、仓库链接和一段实现笔记写回卡片。

不在本期范围：让 agent 做裁决、改分类、退役或删除卡片（M3.6 已经证明模型对重复与分类的判断不稳定，
这正是坚持人工确认的理由）；也不含 agent 投递新能力。

## 2. 形状与鉴权（Human 决定）

- **远程 MCP server**，挂在现有 Railway `web` 服务上：`POST /api/mcp`，用
  `@modelcontextprotocol/sdk` 的 Streamable HTTP transport，**无状态**（每个请求独立，不保存会话），
  这样 Railway 滚动部署不会打断客户端。
- **鉴权走 Cloudflare Access service token**，不新开鉴权体系：Access 里为该 app 增加一条
  Service Auth 策略与一个 service token；客户端带 `CF-Access-Client-Id` / `CF-Access-Client-Secret`
  两个 header，Cloudflare 在边缘换发 JWT，`lib/auth/guard.ts` 照常校验签名、`aud` 与 team domain。
- **必须补一道白名单**：service token 的 JWT 身份在 `common_name` claim 里（不是 `email`）。
  仅仅"JWT 验签通过"意味着**同一个 Access team 里的任何 service token 都能进来**。
  因此新增环境变量 `CF_ACCESS_SERVICE_TOKEN_CN`，只接受与之相等的 `common_name`；
  未配置时，`/api/mcp` 一律 401（fail closed，不退化成"谁都能进"）。
- 浏览器路径不变：人类的 Access JWT 带 `email` 而非 `common_name`，`/api/mcp` 只认后者，
  两条身份互不串用。

## 3. 工具面

业务逻辑不重写：所有工具调用现有的 `lib/library/queries.ts` 与 `lib/library/actions.ts`，
web、Telegram、MCP 三个入口共用同一套查询与同一套乐观锁。

| 工具 | 入参 | 返回 |
|---|---|---|
| `search_capabilities` | `query`（自然语言）、`limit`（默认 10，上限 20，等于 PAGE_SIZE，因为没有分页参数）、可选 `type` / `tags` / `usage` | 编号、标题、类型、评分、`summary` 引子、`summary_points` |
| `get_capability` | `serial`（如 `SKL-0031`） | 完整卡片：要点、价值信号、playbook、来源事实、深度分析（若有）、待核实、自研进度与笔记 |
| `list_to_build` | `limit` | 待自研的卡（`usage='reference'` 且 `progress ∈ (todo, planned)`，仅 `status='active'`） |
| `list_recent` | `limit` | 最近入库的卡 |
| `get_stats` | — | 类型分布、标签数、待 Review 数、待自研数 |
| `set_build_progress` | `serial`、`progress`（`building` / `done` / `dropped`）、可选 `link`、可选 `note`、`by` | 更新后的进度 |
| `append_build_note` | `serial`、`note`、`by` | 追加后的笔记条数 |

**只读工具只返回 `status='active'` 且未删除的卡**，与 web 默认视图一致。
所有返回都不含原图或缩略图二进制，只给编号与 web 链接。

写工具沿用现有乐观锁：并发冲突返回"已在别处处理"的结构化错误，不覆盖。
`set_build_progress` 不允许把进度改回 `todo` / `planned`——那是人的排期动作，不是 agent 的。

## 4. 数据与迁移 013

```sql
ALTER TABLE caphub_v2.capabilities
  ADD COLUMN build_notes jsonb NOT NULL DEFAULT '[]'::jsonb;
```

- 每条笔记是 `{ at, by, text }`：`at` 是写入时刻，`by` 是客户端自报的 agent 名
  （**只用于显示，不作为凭据**——真正的身份是 Access service token），`text` ≤ 2000 字。
- **追加式**：`append_build_note` 与带 `note` 的 `set_build_progress` 都只追加，不覆盖已有条目；
  没有删除接口（要删去 web 改）。
- **纳入检索**：笔记要能被搜到，所以
  1. 重建全文生成列 `search`，把 `build_notes` 加进 `capability_search_text`（第 6 个参数，
     沿用 012 的 drop → 重建函数 → 重建列 → 重建 GIN 索引的做法，注意 IMMUTABLE 约束）；
  2. **同时把 `build_notes::text` 加进 `listLibrary` 的 ILIKE 那条腿**。
     `simple` 配置会把一整串中文切成一个 token，中文搜索实际靠的是 ILIKE——M3.8 漏过一次，
     这里不能再漏。

## 5. 展示

详情页「自研进度」面板下按时间倒序列出笔记（`by` + 相对时间 + 正文）。没有笔记时不渲染空壳标题。
Telegram 卡片不加笔记（会把卡片撑长），但 `/todo` 的卡片在有笔记时标一个计数。

## 6. 客户端接入

- `docs/agent-access.md`：claude / codex / opencode 三种客户端各自的配置片段，例如
  `claude mcp add --transport http caphub https://caphub.agentjoey.ai/api/mcp --header "CF-Access-Client-Id: ..." --header "CF-Access-Client-Secret: ..."`。
  文档里只写变量名占位，**不写真实密钥**。
- 同一份文档给出一段可贴进全局 `CLAUDE.md` 的文字，说明**什么时候该查 Caphub**
  （开始一个新功能前、选型前、遇到"这事儿是不是已经有现成工具"时），以及做完自研后要回写。
  没有这段，工具装上了也不会有人主动用。

## 7. 错误、日志与边界

- 单用户场景不做限流，但限死返回体量：搜索最多 PAGE_SIZE（20）条，卡片正文字段按既有上限截断。
- 所有工具调用记结构化日志：工具名、编号、结果、耗时；**不记 token、不记图片内容、不记密钥**。
- 任何未知工具名、参数校验失败，返回 MCP 标准错误，不抛裸异常。
- `/api/mcp` 不参与 Cloudflare Access 的浏览器登录流程，不设 cookie。

## 8. 测试与验收

- 每个工具一组单测（注入假 pool）：正常返回、空结果、非法编号、写冲突。
- 鉴权单测重点是 **`common_name` 白名单**，必须含负向用例：另一个合法签名但 `common_name` 不匹配的
  token 必须 401；`CF_ACCESS_SERVICE_TOKEN_CN` 未配置时必须 401。
- 迁移 013 在**临时 Neon branch** 上跑两遍（第二次 applied 为空），验证检索能命中只出现在笔记里的中文词，测完删除 branch。
- 真机验收：从另一台机器的 Claude Code 连上去——`search_capabilities("网页动效")` 能搜到 SKL-0031；
  `set_build_progress` 标记某张卡自研中后，web 详情页可见、Telegram `/todo` 不再推送它。

## 9. 需要 Human 授权

1. Cloudflare Access 建 service token 与 Service Auth 策略（面板里 Human 操作，密钥 Human 自行保管）。
2. 生产 Neon 执行迁移 013。
3. 临时 Neon branch 的建与删。

## 10. 风险

- **各家客户端对远程 MCP 与自定义 header 的支持不一**。若某个客户端（如 kimicode）不支持带 header 的
  HTTP MCP，退路是仓库里再加一个很薄的本地 stdio 代理转发到同一个接口——本期不做，遇到再说。
- Access service token 的密钥会出现在各客户端的配置文件里；轮换时所有机器都要改。
