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

## 在一台新机器上安装

密钥只存在每台机器的环境变量里，配置文件只写变量引用——这样配置可以安心放进私有仓库或同步盘，
轮换 token 时每台机器只改一处。

### 第 0 步（每台机器一次）：把两个值放进环境

```bash
# ~/.zshrc（或 ~/.bashrc）
export CAPHUB_CF_ACCESS_CLIENT_ID='...'
export CAPHUB_CF_ACCESS_CLIENT_SECRET='...'
```

变量名**不要**用 `ANTHROPIC_API_KEY` 这类通用凭据名：Claude Code 会把已知的凭据变量名读成空字符串，
以免把密钥泄进子进程；用上面这种带项目前缀的自定义名就不会被拦。

改完 `source ~/.zshrc`，或者开一个新终端——已经在跑的 agent 进程读的是它启动时的环境，不会自动更新。

### Claude Code

```bash
claude mcp add --scope user --transport http caphub https://caphub.agentjoey.ai/api/mcp \
  --header 'CF-Access-Client-Id: ${CAPHUB_CF_ACCESS_CLIENT_ID}' \
  --header 'CF-Access-Client-Secret: ${CAPHUB_CF_ACCESS_CLIENT_SECRET}'
```

**必须用单引号。** zsh/bash 的双引号会把 `${...}` 在命令执行前就展开掉，于是真实密钥被写进
`~/.claude.json`（正是我们要避免的），或者——如果那台机器还没设变量——写进去一个空字符串，
得到一个看着配好、实际永远 401 的服务器。单引号让字面量原样存下，由 Claude Code 在加载时展开。

`--scope user` 写进 `~/.claude.json` 顶层，该机器上所有项目都能用。`${VAR}` 与 `${VAR:-默认值}`
两种写法在 local / project / user 三个 scope 下都支持，作用于 HTTP server 的 `url` 与 `headers`。

装完验证：

```bash
claude mcp list          # 应显示 caphub ✔ Connected
```

或在会话里输入 `/mcp`，能看到 caphub 及其七个工具。

### Codex CLI

在 `~/.codex/config.toml` 加：

```toml
[mcp_servers.caphub]
url = "https://caphub.agentjoey.ai/api/mcp"

[mcp_servers.caphub.env_http_headers]
CF-Access-Client-Id = "CAPHUB_CF_ACCESS_CLIENT_ID"
CF-Access-Client-Secret = "CAPHUB_CF_ACCESS_CLIENT_SECRET"
```

注意 `env_http_headers` 的值是**环境变量的名字**，不是值本身——这正是我们要的：配置文件里没有密钥。
（对照下面「客户端配置」一节里的 `http_headers` 写法，那种是直接写值，只适合临时试验。）

### opencode

`opencode.json` 的 headers 是否支持环境变量插值，本仓库未验证。在确认之前，稳妥做法是让启动 opencode 的
shell 带着这两个环境变量，并按 opencode 自己的文档确认它的插值语法；**不要**把真实值写进会被同步的配置文件。

### 轮换 token 时

在 Cloudflare Access 里换发 service token 后：每台机器改 `~/.zshrc` 里那两行，重开终端，重启 agent。
配置文件一行都不用动。如果新 token 的 `common_name` 变了，还要同步更新 Railway `web` 服务的
`CF_ACCESS_SERVICE_TOKEN_CN`，否则所有机器一起 401（见文末排障第 3 条）。

### 装好后仍然 401？

先确认不是"变量没进到进程里"这一类：

```bash
printenv CAPHUB_CF_ACCESS_CLIENT_ID | head -c 8   # 有输出说明当前 shell 里有值
```

如果这里有值但 agent 仍 401，检查 `~/.claude.json` 里存的是不是字面量 `${CAPHUB_CF_ACCESS_CLIENT_ID}`
——如果存成了真实值或空字符串，就是当初用了双引号，删掉重加即可。

## 附：直接写值的配置形式（仅供临时试验）

**日常安装请用上面的「在一台新机器上安装」**，那套把密钥放在环境变量里。下面这几段把真实值直接写进
配置文件，只适合在一台一次性机器上快速验证端点是否可用；**不要**用于会被同步或提交的配置文件。

以下三段配置里，只有 Claude Code 的一段在本仓库里实际验证过；Codex CLI 和 opencode 的两段
摘自这两个工具各自的官方文档，未在本仓库验证，使用前请对照它们自己的文档核对。

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
| `list_to_build` | 列出还在等待自建、尚未开始的卡片（progress 为 todo / planned）。一旦标记为 building 就会从这个列表移除。想知道"接下来该做什么"时用这个。 |
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
