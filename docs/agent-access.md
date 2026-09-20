# Agent 接入 Caphub

Caphub 在 `POST https://caphub.agentjoey.ai/api/mcp` 上暴露一个远程 MCP server，供
claude / codex / opencode 等 agent 查询与回写 Joey 的能力库。鉴权走 Cloudflare Access
service token，业务逻辑与 web / Telegram 入口共用同一套查询与乐观锁（见
[`docs/superpowers/specs/2026-09-21-caphub-v2-agent-access-design.md`](./superpowers/specs/2026-09-21-caphub-v2-agent-access-design.md)）。

## 前置条件

- 一个 Cloudflare Access service token（Human 在 Access 面板创建并保管），对应一对
  `CF-Access-Client-Id` / `CF-Access-Client-Secret`。
- 该 token 的 `common_name` 已被写进服务端的 `CF_ACCESS_SERVICE_TOKEN_CN` 环境变量——这一步
  只有 Human 能做，不是客户端配置的一部分。

下面所有代码块里的 `<CF_ACCESS_CLIENT_ID>` / `<CF_ACCESS_CLIENT_SECRET>` 都是占位符，
换成 Human 给你的真实值，**不要把真实值提交进任何仓库**。

## 客户端配置

### Claude Code

```bash
claude mcp add --transport http caphub https://caphub.agentjoey.ai/api/mcp \
  --header "CF-Access-Client-Id: <CF_ACCESS_CLIENT_ID>" \
  --header "CF-Access-Client-Secret: <CF_ACCESS_CLIENT_SECRET>"
```

### Codex CLI

在 `~/.codex/config.toml`（或项目内 `.codex/config.toml`，仅受信任项目生效）里加一段：

```toml
[mcp_servers.caphub]
url = "https://caphub.agentjoey.ai/api/mcp"

[mcp_servers.caphub.http_headers]
CF-Access-Client-Id = "<CF_ACCESS_CLIENT_ID>"
CF-Access-Client-Secret = "<CF_ACCESS_CLIENT_SECRET>"
```

Codex 也支持 `env_http_headers`，从环境变量取值而不是把值写进配置文件；密钥怕落地到文件时优先用这个。

### opencode

在 `opencode.json` 里加一段：

```json
{
  "mcp": {
    "caphub": {
      "type": "remote",
      "url": "https://caphub.agentjoey.ai/api/mcp",
      "enabled": true,
      "headers": {
        "CF-Access-Client-Id": "<CF_ACCESS_CLIENT_ID>",
        "CF-Access-Client-Secret": "<CF_ACCESS_CLIENT_SECRET>"
      }
    }
  }
}
```

### 协议边界

服务端只实现了 MCP 里 POST+JSON 的一个手写子集：`initialize`、`notifications/*`、
`tools/list`、`tools/call`、`ping`。没有 SSE/GET 流式端点。如果某个客户端的 MCP 实现
强制要求 SSE（GET 一个事件流），这个 endpoint 对它不可用——遇到时退路是本地起一个很薄的
stdio 代理转发到同一个接口，本期没做。

## 什么时候用它，什么时候回写

把下面这段原样贴进全局 `CLAUDE.md`（或等价的 agent 指令文件）：

```markdown
## Caphub 能力库
开始一个新功能、做技术选型、或者怀疑"这事是不是已经有现成方案"时，先用 caphub 的
`search_capabilities` 查一下 Joey 的能力库。库里标为"参考自研"的能力，如果你按它动手实现了，
完成后用 `set_build_progress` 回写进度、仓库链接和一段实现笔记（踩了什么坑、与原能力的差异）。
不要用它做裁决、改分类或删除——那些只有 Joey 能做。
```

## 七个工具

一句话说明，逐字取自 `lib/mcp/schema.ts` 里各工具的 `description`（已发布进 `tools/list`）：

| 工具 | 一句话说明 |
|---|---|
| `search_capabilities` | 用自然语言在 Joey 的能力库里找相关能力（技能 / 工具 / 模型 / 提示词 / 经验）。开始做一个新功能、选型、或者怀疑"这事是不是已经有现成方案"时先查这里。 |
| `get_capability` | 按编号（如 SKL-0031 或 #31）取一张卡片的完整详情，包括 playbook、来源事实、开放问题和已有的自建笔记。已经从搜索里拿到编号、要看具体怎么用之前调用这个。 |
| `list_to_build` | 列出已保留、仅供参考、还在等待或正在自建的卡片（/todo 集合）。想知道"接下来该做什么"时用这个。 |
| `list_recent` | 列出最近新增的、已保留且生效中的卡片。想看看库里最近多了什么时用这个。 |
| `get_stats` | 取库的整体统计（按类型计数、标签数、待处理数、待自建数）。想要一个总览数字而不是列表时用这个。 |
| `set_build_progress` | 把一张卡片的自建进度改为 building / done / dropped（todo / planned 是人来排期，agent 不能设置）。可选地同时附一条笔记。开始/完成/放弃自建一个能力时调用。 |
| `append_build_note` | 给一张卡片追加一条自建笔记，不改变进度。记录调研发现、遇到的坑等，用这个而不是 set_build_progress。 |

`set_build_progress` 的 `progress` 参数只接受 `building` / `done` / `dropped`；传
`todo` 或 `planned` 会被拒绝（这是设计使然，不是 bug）——排期是 Joey 的动作，不是 agent 的，
不要重试。

## 排障：收到 401

`/api/mcp` 的鉴权是 fail closed 的，三种原因都会表现成同一个 401，需要逐个排查：

1. **header 缺失或名字/大小写不对**：必须同时带 `CF-Access-Client-Id` 和
   `CF-Access-Client-Secret` 两个 header，值和你拿到的 service token 一致。检查客户端配置里
   header 名字有没有打错（例如漏了 `Cf-` 前缀、把 `-Id` 打成 `-ID`）。
2. **Access 里的 Service Auth 策略没有覆盖这个 token**：即便 header 都对，如果 Cloudflare
   Access 面板里这条 service token 没有被加进 `caphub.agentjoey.ai` 对应 app 的 Service Auth
   策略，边缘就不会换发 JWT，请求直接被 Access 拦下——这一步只有 Human 能在 Access 面板里改。
3. **服务端白名单不匹配**：即便 JWT 验签通过，`lib/auth/guard.ts` 还会比对 JWT 里的
   `common_name` 是否等于服务端环境变量 `CF_ACCESS_SERVICE_TOKEN_CN`。两者不一致，或者服务端
   根本没配置这个环境变量（未配置时无条件 401，不会退化成"验签通过就放行"），都会 401。
   这一步同样只有能改 Railway 环境变量的人能修。

浏览器登录走的是人的 Access 身份（JWT 里带 `email`），和 `/api/mcp` 认的 `common_name` 是两条
互不相通的身份链路——用浏览器账号能登录网页，不代表能连上 MCP endpoint。
