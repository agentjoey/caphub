# Caphub v2 — Telegram Mini App 设计（AJ-301）

**状态**：2026-09-21 由 Human 逐节确认。承接 `docs/superpowers/specs/2026-09-19-caphub-v2-design.md`
与 `2026-09-21-caphub-v2-agent-access-design.md`。

## 1. 要解决的问题

今天在 Telegram 里已经能投递、打字搜索、用按钮处理卡片；缺的是**浏览**——翻库、筛选、看详情、
看深度分析。现有出口是卡片上的「🔗 去 web」，它跳出 Telegram 打开外部浏览器，然后撞上
Cloudflare Access 的邮箱验证码登录。

**本期价值 = 消除手机上「跳出去再登录一次」这段摩擦**，而不是「Telegram 原生外观」本身。

不在本期范围：把 Mini App 做成与 web 并行维护的第二套视觉；Telegram 内的问答式 agent（AJ-300）。

## 2. 范围（Human 决定）

**完整闭环**：web 能做的，Mini App 都能做——浏览、检索、裁决（保留 / 丢弃）、改建议、
自研进度与笔记、重跑分析、深度分析、状态与退役。

这个选择把安全要求顶到最高：这条路径将能改库里的任何东西，所以第 3 节的鉴权不是形式。

## 3. 鉴权：三道关，一道都不减

**Cloudflare Access 保留在 Mini App 前面**（Human 决定）。Telegram 的内置浏览器就是浏览器，
有独立 cookie 空间：首次打开会撞上 Access 登录，在手机上收验证码粘进去即可，之后 cookie
在 WebView 内留存到 session 到期。**因此不新开任何公网可达、只靠自有代码守护的路径。**

**关键技术事实**：Telegram 的 `initData` 放在 URL fragment（`#tgWebAppData=...`）里，
浏览器不会把 fragment 发给服务器——服务端在首次页面加载时**拿不到**它。所以：

1. 客户端壳层加载后读 `Telegram.WebApp.initData`，调一次 `POST /api/mini/session`；
2. 服务端用 `TELEGRAM_BOT_TOKEN` 验 HMAC（按 Telegram 规范：`secret = HMAC_SHA256("WebAppData", botToken)`，
   再对排序后的 data-check-string 求 HMAC 比对）、校验 `auth_date` 在 5 分钟内、核对
   `user.id` 等于 `TELEGRAM_OWNER_CHAT_ID`；
3. 通过后下发 **HttpOnly + Secure + SameSite=Lax、签名、短时效（12 小时）** 的会话 cookie；
4. 之后的页面导航与写操作都带该 cookie，服务端逐次校验；过期时壳层静默重新走第 1 步。

三道关，写操作必须全过：**Access JWT（边缘）→ mini session cookie（应用）→ 既有乐观锁（数据）**。

`/mini` 与 `/api/mini/*` 不接受 service token 身份（那是 `/api/mcp` 的），也不接受
「只有 Access 通过但没有 mini session」的写请求。

## 4. 入口（Human 决定）

- **bot 菜单按钮**（`setChatMenuButton`）→ `/mini`，用于从头翻库。
- **卡片上的「🔗 去 web」改为 `web_app` 类型按钮**，URL 直接带该卡路径 `/mini/library/<id>`。
  不用 `startapp` 参数，因为按钮的 URL 由我们自己拼，省掉一次参数解析。
  `web_app` 内联按钮只在私聊可用，与本项目的单人私聊场景一致。
- 历史消息里的旧「去 web」按钮仍是普通 URL 按钮，行为不变，不做迁移。

## 5. 页面

| 路由 | 内容 |
|---|---|
| `/mini` | 库列表：搜索框（复用 `listLibrary` 混合检索）、类型 / 场景 / 待自研筛选 chips、卡片行（编号 · 标题 · 评分 · 最多 3 个标签）。统计并入顶部，不单独成页 |
| `/mini/library/[id]` | 详情：深度分析置顶（若有）、结构化摘要、价值信号、怎么用、来源事实、自研进度与笔记、原始投递（默认折叠） |
| `/mini/review` | 待决卡片：保留 / 丢弃 / 改建议 |

业务逻辑不重写：全部调用现有的 `lib/library/queries.ts` 与 `lib/library/actions.ts`，
与 web、Telegram 卡片、MCP 共用同一套查询与同一套乐观锁。

## 6. 交互：原生在手感，不在配色（Human 决定）

1. **BackButton 接管层级**：详情 → 列表用 Telegram 自己的返回键；页面内不再画返回按钮。
2. **MainButton 承载当前主操作**：Review 页是「保留」，详情页按状态变（未开始自研时是「开始自研」）。
   它是**单一**主按钮，次要操作留在页面内——否则主按钮会变成杂物抽屉。
3. **触感反馈**：真正改数据的动作（裁决、改进度）用 `notificationOccurred`；普通点击用轻 `impact`。
4. **跟随深浅色**：按 `colorScheme` 切换，底色取 `themeParams`；卡片、药丸徽标、字体仍是 Caphub
   那套（M3.8 的版面成果在这里继续用，不另起一套视觉）。

**工程约束**：`Telegram.WebApp` 只存在于客户端，而现有页面是服务端渲染的。壳层必须把这些 API
封装进 client component，并处理「首次渲染时 WebApp 尚不存在」的那一帧，否则会水合错乱。
BackButton / MainButton 的注册必须在组件卸载时解绑，不然跨页会留下上一页的按钮行为。

## 7. 测试与验收

- `initData` 验证单测，**负向用例是重点**：伪造签名、篡改字段、`auth_date` 过期、
  `user.id` 不是 owner、缺少 `hash`、空 `initData`。
- 会话 cookie 单测：签名校验、过期、篡改；无 cookie 的写请求必须被拒。
- 组件测试：用假的 `WebApp` 对象验证 BackButton / MainButton 的注册与**解绑**、主题切换。
- **真机走查（不可省略）**：iPhone Telegram 上走一遍列表 → 检索 → 详情 → 裁决 → 改进度 →
  返回键 → 深浅色切换。WebView 的真实行为无法用自动化测试覆盖。
- 截图只能真机截：`scripts/shot.mjs` 进不了 Telegram 的 WebView。

## 8. 需要 Human 操作

1. 把 `TELEGRAM_BOT_TOKEN` 加到 Railway 的 `web` 服务（worker 已有，值相同）。
2. 调长 Cloudflare Access 邮箱策略的 session duration，减少在 WebView 里过验证码的频率。
3. 真机走查。

## 9. 风险

- **iOS WebView 行为差异**：键盘弹出后的视口高度需用 `viewportStableHeight` 处理，否则底部主按钮会被顶飞。
- **两套入口的一致性**：Mini App 与 web 共用查询与动作层，但版面是两处；改动卡片结构时要同时看两边。
- **Access 在 WebView 内的登录体验**：首次或过期时要在 Telegram 内完成邮箱验证码。这是为保住
  安全边界主动接受的代价；若实际体验不可接受，退路是把 Mini App 收窄为只读并为其放行 Access，
  但那要 Human 重新决定，不在本期自行降级。
- 无数据库迁移，回滚即回滚代码与 bot 按钮配置。
