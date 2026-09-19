# Caphub v2 — M3（Telegram：投递 / 搜索 / 推送 / 按钮决定）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 手机上发图即投递、发一句话即搜库、裁决结果推到私聊并能一键决定。

**Spec:** `docs/superpowers/specs/2026-09-19-caphub-v2-design.md` §7（本文件的「设计决定」是对它的增补，2026-09-20 由 Human 选定）。

## 设计决定（Human 已选定 / 本次增补）

1. **Bot**：复用 `Mario | Futu`（`@supermario_agent_bot`，id 8769790676）。futu 的 launchd 任务已注销停用；`TELEGRAM_BOT_TOKEN`、`TELEGRAM_OWNER_CHAT_ID=7747462834` 已写入 Railway worker；`TELEGRAM_ENABLED` 仍为 `false`，本里程碑验收通过后再打开。只认 owner chat id，其它 chat 静默丢弃并计数。长轮询，不用 webhook。
2. **消息语义**（与原 spec 不同，Human 选定）：
   - 图片（photo，或 image/* 的 document）→ **投递**；
   - 纯 URL 文本 → **投递**；
   - `/add <文字>`（或对某条消息回复 `/add`）→ **文字投递**；
   - 其它纯文字 → **搜索**能力库（等价于 `/find <文字>`）。
3. **回执与结果同条消息**：投递后立刻回复「已收到，分析中…」，把这条回执的 `chat_id`/`message_id` 记进 `captures`；裁决完成后**编辑这条回执**成结果卡，不再新发一条。补发（`notified_at IS NULL` 且回执丢失）时才新发。
4. **一次发多张图**：每张各自回执、各自结果、各自按钮（Human 选定）。
5. **待决卡按钮**：`保留 / 丢弃 / 重跑分析 / 去 web`（与 web Review 页一致）。前三个是 callback，最后一个是 URL 按钮。决定后编辑原消息为结果并移除按钮；乐观锁冲突则编辑为「已在别处处理」。
6. **搜索结果**：复用 web 的混合检索（语义 + 全文 + 场景 + 子串），返回前 5 条：`SKL-0003 · 标题 · 类型 · 场景` + 详情链接；`SKL-3` / `#3` 直接定位；无结果给一句提示。worker 需要 `GEMINI_API_KEY`（已配）。
7. **命令菜单**（由 Caphub 用 `setMyCommands` 写入，不用 BotFather 手动加）：`/help`、`/add`、`/find`、`/pending`、`/stats`。
8. **语言**：Telegram 文案固定中文（M2.5 的中英切换只作用于 web）。
9. **不在本期**：Telegram Mini App（用签名登录替掉「去 web」按钮，需给 web 单开一条不走 Cloudflare Access 的路径）、群聊、多用户、主动推荐。记入 M4 之后的候选。

## 需要 Human 配合

- BotFather 改 bot 名称与头像（命令菜单由代码写入，不用手动加）。
- 验收阶段用手机真机走查；验收通过后由我把 worker 的 `TELEGRAM_ENABLED` 设为 `true`。
- 授权：验收期间对真实 bot 发消息（调用 Telegram API）、对生产库写入测试投递（测试卡随后删除）。

## Global Constraints

- Telegram 文案中文；不显示内部 id（`cab_…`/`cap_…`/`run_…`），编号 `SKL-0012` 可显示。
- 密钥只存在 Railway；日志不含 token、图片内容、消息正文全文（可记长度与类型）。
- 测试不连真实 DB / Telegram / 模型：所有 Telegram API 调用经注入的 `fetch`，DB 经假 pool。
- `callback_data` ≤ 64 字节。
- 复用既有决定函数（`lib/library/actions.ts` 的 `decide` / `requestRerun`），不另写一套裁决逻辑；乐观锁仍用 `date_trunc('milliseconds', updated_at)` 口径。
- 所有 Telegram 出站调用都要带超时与 429 `retry_after` 退避，且一次失败不得让 worker 主循环退出。

---

### Task 1: Telegram API 客户端

**Files:** `lib/telegram/api.ts`(+test)、`lib/telegram/errors.ts`（若需）

- [ ] `createTelegramApi({ token, fetch?, timeoutMs? })`，方法：`getUpdates({offset, timeout})`（长轮询，HTTP 超时 = timeout + 10 s）、`sendMessage`、`editMessageText`、`answerCallbackQuery`、`getFile`、`downloadFile`、`setMyCommands`、`getMe`。
- [ ] 统一错误：非 2xx 或 `ok:false` → `TelegramError{ code, description, retryAfter? }`；429 读 `parameters.retry_after`；`AbortSignal` 透传；token 只进 URL path，不进日志。
- [ ] `sendMessage`/`editMessageText` 支持 `reply_markup`（inline keyboard）与 `parse_mode: "HTML"`；提供 `escapeHtml`。
- [ ] 测试（注入 fetch）：正常返回解包 `result`；429 带 retryAfter；超时中断；下载返回 bytes；不记录 token。

### Task 2: 消息路由与分类

**Files:** `lib/telegram/router.ts`(+test)

- [ ] `classifyUpdate(update, { ownerChatId })` → 判别联合类型：
  `{kind:"ignored", reason}` | `{kind:"image", fileId, messageId, chatId}` | `{kind:"url", url, …}` | `{kind:"text-capture", text, …}` | `{kind:"search", query, …}` | `{kind:"command", name, arg, …}` | `{kind:"callback", action:"keep"|"discard"|"rerun", capabilityId, updatedAt, callbackId, chatId, messageId}`。
- [ ] 规则：非 owner chat → ignored(not-owner)；photo 取最大尺寸 `file_id`；`document` 且 mime 为 image/png|jpeg|webp → image；文本 trim 后：以 `/` 开头 → command（`/add` 带参或回复消息 → text-capture；`/find` 带参 → search）；整体是 http(s) URL → url；否则 → search。空文本、贴纸、语音等 → ignored(unsupported)。
- [ ] callback_data 编解码：`encodeDecision(action, capabilityId, updatedAtIso)` → `k|<id>|<epochMs>`（`k|d|r` 三种前缀），`decodeDecision` 严格校验长度 ≤ 64 与格式。
- [ ] 测试覆盖每条规则与边界（带 caption 的图片、`/add` 回复形态、超长文本截断、伪造 callback_data）。

### Task 3: 从 Telegram 投递

**Files:** `lib/telegram/capture.ts`(+test)、`lib/captures/captures.ts`（记 telegram 字段）

- [ ] `handleCapture(deps, msg)`：下载图片（限 10 MB，超限回「图片太大」）→ 复用 `submitCapture`（`source:"telegram"`）→ 回复「已收到，分析中…」→ 把回执的 `telegram_chat_id`/`telegram_message_id` 写进该 capture。
- [ ] 重复投递：`submitCapture` 已返回重复信息 → 回复「这条之前投过：<编号或标题>」+ 详情链接，不入队。
- [ ] URL 与 `/add` 文字走同一路径（不下载文件）。
- [ ] 失败（下载失败 / S3 失败）→ 回复一句人话错误，不抛出到主循环。
- [ ] 测试：假 api + 假 store + 假 pool，覆盖图片、URL、文字、重复、超大文件、下载失败。

### Task 4: 结果推送

**Files:** `lib/telegram/format.ts`(+test)、`lib/telegram/notify.ts`(+test)

- [ ] `formatResult(card)` 四种：
  - 自动保留：`✅ 已保留 · SKL-0007` + 标题 + 类型 / 用法 + 场景 + 标签 + 详情链接；
  - 自动丢弃：`🗑 已丢弃` + 标题 + 理由一句 + 详情链接；
  - 待决：标题 + 建议与理由 + 摘要前 300 字 + 类型 / 场景 / 标签 + 四个按钮；
  - 失败：`❌ 分析失败 · <原因>` + 「重跑」按钮。
- [ ] `runNotifyTick(deps, signal)`：取 `notified_at IS NULL` 且已有裁决或运行失败、且 capture 来源为 telegram 的卡（每轮 ≤ 10）；优先 `editMessageText` 改写回执，回执不存在或编辑失败（消息被删）→ `sendMessage`；成功后写 `notified_at = now()`（不动 `updated_at`）。
- [ ] 429 / 网络错误：本轮跳过该卡，不写 `notified_at`，下轮重试；连续错误走与 embed tick 相同的退避思路（复用 `lib/worker/embed-backoff.ts`）。
- [ ] 测试：四种文案快照式断言（含编号、无编号两种）、编辑失败回退新发、失败不写 notified_at。

### Task 5: 按钮决定

**Files:** `lib/telegram/decide.ts`(+test)

- [ ] `handleCallback(deps, cb)`：解码 → 读取该卡当前 `updated_at` 与按钮携带值比对不一致 → `answerCallbackQuery("已在别处处理")` 并把消息编辑成当前状态；一致则调用 `decide` / `requestRerun`。
- [ ] 成功后：`answerCallbackQuery("已保留")` 等，并把原消息编辑成结果文案、移除按钮；重跑则编辑为「已重新排队，分析中…」并清 `notified_at` 以便新结果再次推送。
- [ ] `OBJECT_GONE`（原图已清除无法重跑）、`CONFLICT`、未知 id → 各自的人话提示。
- [ ] 测试：正常三种动作、冲突、对象已清除、伪造 callback_data、非 owner。

### Task 6: 搜索与命令

**Files:** `lib/telegram/search.ts`(+test)、`lib/telegram/commands.ts`(+test)

- [ ] `handleSearch(deps, query)`：`parseSerialQuery` 命中 → 直接返回该卡；否则调用与 web 相同的检索（`listLibrary` + 查询向量 + 场景匹配），取前 5，格式化为一条消息（每条：编号 · 标题 · 类型 · 场景 + 链接），无结果 → 「没找到，换个词试试，或去 web 看看」。
- [ ] 命令：`/help`（一屏说明：发图=投递、发链接=投递、/add 文字=投递、直接打字=搜索）、`/pending`（列出待决卡，每条一条带按钮的消息，≤ 5 条，多的给链接）、`/stats`（各类型数量、标签数、待 Review 数）、`/find`（= 搜索）、`/add`（= 文字投递）。
- [ ] `syncCommands(api)`：worker 启动时 `setMyCommands` 写入上述五条中文描述（失败只记日志）。
- [ ] 测试：搜索命中编号、语义命中、空结果、/stats 文案、/pending 分页、命令同步调用参数。

### Task 7: 接入 worker 与上线

**Files:** `lib/telegram/loop.ts`(+test)、`scripts/worker.ts`、`lib/db/migrations/006_telegram_offset.sql`、`docs/deploy.md`

- [ ] 迁移 006：`CREATE TABLE caphub_v2.telegram_state (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`，用于持久化 `getUpdates` 的 offset（Railway 重启不丢、不重复处理），并授予 app 角色读写。
- [ ] `runTelegramTick(deps, signal)`：读 offset → `getUpdates(timeout=25)` → 逐条路由分发（Task 2–6）→ 每条处理完写回 offset（一条处理失败记日志并跳过，offset 仍前进，避免毒消息卡死）。
- [ ] `scripts/worker.ts`：仅当 `config.telegram.enabled` 时启动长轮询与通知轮询；错误不终止主循环；启动时调用 `syncCommands` 与 `getMe` 自检（失败只告警）。
- [ ] `docs/deploy.md` 增加 M3 小节：迁移 006 → 部署 → `TELEGRAM_ENABLED=true` → 真机走查 → 回滚办法（把开关改回 false）。
- [ ] 测试：一轮 tick 处理混合更新（图片 + 文本 + callback）、offset 持久化、毒消息跳过、enabled=false 时不启动。

### Task 8: 真机验收

- [ ] Human 在 BotFather 改名与头像后，由 controller 打开 `TELEGRAM_ENABLED`，与 Human 一起走查：发图 → 收到回执 → 回执变成结果卡 → 按钮保留 → web 上能看到且编号已分配；发链接、`/add 文字`、直接打字搜索、`SKL-3`、`/pending`、`/stats`。
- [ ] 把走查结果写入 `docs/m3-verification.md`（含截图），删除测试投递的卡。

## Self-review

- 覆盖 spec §7 全部条目：长轮询、owner 限定、投递三种、回执、重复、四类推送、按钮与共用决定函数、`notified_at` 补发、断线重连、日志不含敏感内容。
- 新增并与 Human 确认：文字=搜索 / `/add`=投递、按钮加「重跑」、每张图单独推送、命令菜单由代码写入、Mini App 留到以后。
- 风险：`callback_data` 64 字节上限（Task 2 已做长度校验）；编辑回执可能因消息被删失败（Task 4 有回退）；毒消息卡死长轮询（Task 7 offset 仍前进）。
