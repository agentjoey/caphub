# Caphub v2 — Telegram Mini App（AJ-301）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Telegram 内直接翻库、读卡、处理卡片，不再跳出去开浏览器。

**Architecture:** `/mini` 下一组页面，复用现有的 `lib/library/queries.ts` 与 `app/actions.ts`；
Cloudflare Access 仍在最前面，应用内再加一道 Telegram `initData` 换来的短时效会话 cookie；
交互用 Telegram 的 BackButton / MainButton / 触感，视觉沿用 Caphub 现有卡片语言。

**Tech Stack:** Next 16 App Router（server actions）、React 19、TypeScript、node:crypto（HMAC）、Vitest、Testing Library。

**Spec:** `docs/superpowers/specs/2026-09-21-caphub-v2-telegram-miniapp-design.md`

## Global Constraints

- **三道关，写操作必须全过**：Access JWT（边缘）→ mini session cookie（应用）→ 既有乐观锁（数据）。
- **`initData` 服务端在首次加载时拿不到**（它在 URL fragment 里），必须由客户端读出后调
  `POST /api/mini/session` 换 cookie。任何"在服务端直接读 initData"的写法都是错的。
- **`auth_date` 新鲜度 300 秒**；`user.id` 必须等于 `TELEGRAM_OWNER_CHAT_ID`。
- **所有 HMAC 比较使用 `crypto.timingSafeEqual`**，长度不等时先判长度再比较，不得用 `===` 比字符串。
- **绝不记录 `initData`、cookie 值、bot token 或其任何片段**。
- 业务逻辑不重写：查询走 `lib/library/queries.ts`，写操作走 `app/actions.ts`，与 web / Telegram 卡片 / MCP 共用同一套乐观锁。
- 视觉沿用 Caphub 现有卡片语言与配色变量；只按 `colorScheme` 切深浅底色，不引入第二套视觉系统。
- 提交信息结尾附带：`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- 无数据库迁移。

## File Structure

| 文件 | 职责 |
|---|---|
| `lib/telegram/init-data.ts`（新） | 纯函数：验 `initData` 的 HMAC、`auth_date`、owner，返回 `{ ok, userId }` |
| `lib/telegram/mini-session.ts`（新） | 签发 / 校验 mini 会话 cookie（唯一知道 cookie 格式的地方） |
| `app/api/mini/session/route.ts`（新） | 客户端用 `initData` 换 cookie 的唯一端点 |
| `lib/auth/guard.ts`（改） | `/mini` 前缀在 Access 之后再要求 mini cookie；`/api/mini/session` 例外 |
| `components/mini/telegram-webapp.tsx`（新） | `Telegram.WebApp` 的 client 封装：就绪状态、主题、触感 |
| `components/mini/back-button.tsx`、`main-button.tsx`（新） | 声明式绑定 Telegram 原生按钮，卸载时解绑 |
| `app/mini/layout.tsx`、`app/mini/page.tsx`（新） | 壳层与库列表 |
| `app/mini/library/[id]/page.tsx`、`app/mini/review/page.tsx`（新） | 详情与待决 |
| `app/mini/mini.css`（新） | 只放 Mini App 特有的版面与主题变量映射 |
| `lib/telegram/commands.ts`、`format.ts`（改） | bot 菜单按钮；卡片按钮改 `web_app` |

---

### Task 1: initData 验证与会话 cookie

**Files:**
- Create: `lib/telegram/init-data.ts` + `lib/telegram/init-data.test.ts`
- Create: `lib/telegram/mini-session.ts` + `lib/telegram/mini-session.test.ts`
- Create: `app/api/mini/session/route.ts`
- Modify: `lib/auth/guard.ts`、`lib/auth/guard.test.ts`

**Interfaces:**
- Produces: `verifyInitData(initData: string, opts: { botToken: string; ownerId: string; now?: Date; maxAgeSeconds?: number }): { ok: true; userId: string } | { ok: false; reason: "malformed" | "bad_hash" | "stale" | "not_owner" }`
- Produces: `MINI_COOKIE = "caphub_mini"`、`issueMiniSession(userId: string, opts: { botToken: string; now?: Date }): string`、`verifyMiniSession(value: string | undefined, opts: { botToken: string; ownerId: string; now?: Date }): boolean`
- Produces: `guardRequest` 对 `/mini` 与 `/api/mini/*` 的行为（见 Step 7）

- [ ] **Step 1: 写 initData 的失败测试**

Telegram 的规范：`secret = HMAC_SHA256(key="WebAppData", msg=botToken)`，
`hash = HMAC_SHA256(key=secret, msg=dataCheckString)`，其中 dataCheckString 是除 `hash` 外
所有 `key=value` 按 key 升序用 `\n` 连接。测试里照这个算出合法签名，不要硬编码常量：

```ts
import { createHmac } from "node:crypto";

const BOT = "123456:test-token";
const OWNER = "99";

function sign(fields: Record<string, string>, botToken = BOT): string {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

const fresh = (over: Record<string, string> = {}) => ({
  auth_date: String(Math.floor(Date.now() / 1000)),
  query_id: "AAE",
  user: JSON.stringify({ id: 99, first_name: "J" }),
  ...over
});

it("accepts a correctly signed, fresh payload from the owner", () => {
  expect(verifyInitData(sign(fresh()), { botToken: BOT, ownerId: OWNER }))
    .toEqual({ ok: true, userId: "99" });
});

it("rejects a tampered field even though the hash is well-formed", () => {
  const signed = sign(fresh());
  const tampered = signed.replace("first_name%22%3A%22J", "first_name%22%3A%22X");
  expect(verifyInitData(tampered, { botToken: BOT, ownerId: OWNER }))
    .toEqual({ ok: false, reason: "bad_hash" });
});

it("rejects a payload signed with a different bot token", () => {
  expect(verifyInitData(sign(fresh(), "999:other"), { botToken: BOT, ownerId: OWNER }))
    .toMatchObject({ ok: false, reason: "bad_hash" });
});

it("rejects an auth_date older than 300 seconds", () => {
  const old = String(Math.floor(Date.now() / 1000) - 301);
  expect(verifyInitData(sign(fresh({ auth_date: old })), { botToken: BOT, ownerId: OWNER }))
    .toMatchObject({ ok: false, reason: "stale" });
});

it("rejects an auth_date in the future beyond the same window", () => {
  const future = String(Math.floor(Date.now() / 1000) + 301);
  expect(verifyInitData(sign(fresh({ auth_date: future })), { botToken: BOT, ownerId: OWNER }))
    .toMatchObject({ ok: false, reason: "stale" });
});

it("rejects a valid signature from somebody who is not the owner", () => {
  const other = sign(fresh({ user: JSON.stringify({ id: 1234, first_name: "Z" }) }));
  expect(verifyInitData(other, { botToken: BOT, ownerId: OWNER }))
    .toMatchObject({ ok: false, reason: "not_owner" });
});

it("rejects empty, hash-less and unparseable input", () => {
  for (const bad of ["", "hash=abc", "user=notjson&auth_date=1&hash=abc"]) {
    expect(verifyInitData(bad, { botToken: BOT, ownerId: OWNER }).ok).toBe(false);
  }
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run lib/telegram/init-data.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 init-data.ts**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_MAX_AGE_SECONDS = 300;

export type InitDataResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "malformed" | "bad_hash" | "stale" | "not_owner" };

function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;               // timingSafeEqual throws on length mismatch
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export function verifyInitData(initData: string, opts: { botToken: string; ownerId: string; now?: Date; maxAgeSeconds?: number }): InitDataResult {
  if (!initData || !opts.botToken) return { ok: false, reason: "malformed" };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]+$/i.test(hash)) return { ok: false, reason: "malformed" };
  params.delete("hash");
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(opts.botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest("hex");
  if (!hexEqual(hash.toLowerCase(), expected)) return { ok: false, reason: "bad_hash" };

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate)) return { ok: false, reason: "malformed" };
  const nowSeconds = Math.floor((opts.now?.getTime() ?? Date.now()) / 1000);
  // Both directions: a clock-skewed or replayed future timestamp is as suspect as an old one.
  if (Math.abs(nowSeconds - authDate) > (opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS)) return { ok: false, reason: "stale" };

  let userId: string;
  try {
    const user = JSON.parse(params.get("user") ?? "");
    userId = String(user?.id ?? "");
  } catch { return { ok: false, reason: "malformed" }; }
  if (!userId) return { ok: false, reason: "malformed" };
  if (userId !== String(opts.ownerId)) return { ok: false, reason: "not_owner" };
  return { ok: true, userId };
}
```

注意排序：先 `map` 成 `k=v` 再 `sort()`，与 Telegram 规范一致（按整行升序，等价于按 key 升序）。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run lib/telegram/init-data.test.ts`
Expected: PASS

- [ ] **Step 5: 写会话 cookie 的失败测试与实现**

```ts
it("round-trips a freshly issued session", () => {
  const v = issueMiniSession("99", { botToken: BOT });
  expect(verifyMiniSession(v, { botToken: BOT, ownerId: "99" })).toBe(true);
});

it("rejects a session that expired", () => {
  const issued = issueMiniSession("99", { botToken: BOT, now: new Date("2026-09-21T00:00:00Z") });
  const later = new Date("2026-09-21T12:00:01Z");   // 12h TTL + 1s
  expect(verifyMiniSession(issued, { botToken: BOT, ownerId: "99", now: later })).toBe(false);
});

it("rejects a tampered payload, a tampered signature, and a different bot token", () => {
  const v = issueMiniSession("99", { botToken: BOT });
  const [payload, sig] = v.split(".");
  const otherPayload = Buffer.from(JSON.stringify({ u: "1234", e: Date.now() + 1000 })).toString("base64url");
  expect(verifyMiniSession(`${otherPayload}.${sig}`, { botToken: BOT, ownerId: "99" })).toBe(false);
  expect(verifyMiniSession(`${payload}.${"0".repeat(sig.length)}`, { botToken: BOT, ownerId: "99" })).toBe(false);
  expect(verifyMiniSession(v, { botToken: "999:other", ownerId: "99" })).toBe(false);
});

it("rejects a session belonging to another user, and undefined", () => {
  expect(verifyMiniSession(issueMiniSession("1234", { botToken: BOT }), { botToken: BOT, ownerId: "99" })).toBe(false);
  expect(verifyMiniSession(undefined, { botToken: BOT, ownerId: "99" })).toBe(false);
});
```

实现：`payload = base64url(JSON({ u: userId, e: expiresAtMs }))`，
`sig = HMAC_SHA256(key = HMAC_SHA256("CaphubMiniSession", botToken), msg = payload)` 的 hex，
cookie 值为 `payload.sig`。用独立的 key 派生串（`"CaphubMiniSession"`）与 initData 的 `"WebAppData"`
区分开，避免两种用途共用同一把密钥。比较同样走 `timingSafeEqual`。

- [ ] **Step 6: 写 session 端点**

`app/api/mini/session/route.ts`：读 body 里的 `initData` → `verifyInitData` → 失败返回 401
（响应体只给 `{ error: "unauthorized" }`，**不回显 reason**，避免把哪一步失败告诉攻击者；
reason 只进服务端日志）→ 成功则 `Set-Cookie`（`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`）。

- [ ] **Step 7: 守卫收口（这是本任务最关键的一步）**

Next 的 server action 会 **POST 到当前页面的路径**，所以只要在 `guardRequest` 里守住 `/mini`
前缀，页面加载与写操作就一并被守住，无需逐个 action 判断。在既有的 Access 校验之后加：

```ts
const path = request.nextUrl.pathname;
// /api/mini/session is how a client GETS the cookie — it must pass Access but cannot require
// the very cookie it issues.
if (path === "/api/mini/session") return NextResponse.next();
if (path === "/mini" || path.startsWith("/mini/")) {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const ownerId = env.TELEGRAM_OWNER_CHAT_ID?.trim();
  // Fail closed, exactly like /api/mcp: without the secrets we cannot verify anything.
  if (!botToken || !ownerId) { logMcpRefusal("allowlist_unset", path); return unauthorized(); }
  if (!verifyMiniSession(request.cookies.get(MINI_COOKIE)?.value, { botToken, ownerId })) {
    logMcpRefusal("cn_mismatch", path);
    return unauthorized();
  }
}
```

拒绝日志沿用既有的原因代码机制（只记原因与路径，不记 cookie 或 token）；若既有函数名只贴合
MCP，重命名为通用名并同步改既有调用处，**不要复制一份**。

守卫测试必须含：无 cookie 的 `/mini` 页面请求 401；无 cookie 的 `/mini/library/x` POST（模拟
server action）401；`/api/mini/session` 无 cookie 也能过；未配置 bot token 时 `/mini` 一律 401；
持有效 cookie 时放行；**持 mini cookie 去 `/api/mcp` 必须仍然 401**（身份不串用）。

- [ ] **Step 8: 全量检查并提交**

Run: `npm test && npm run typecheck && npm run lint && npm run build`

```bash
git add lib/telegram/init-data.ts lib/telegram/init-data.test.ts lib/telegram/mini-session.ts lib/telegram/mini-session.test.ts app/api/mini lib/auth
git commit -m "feat(mini): verify Telegram initData and gate /mini behind a session cookie"
```

---

### Task 2: Mini 壳层与原生按钮封装

**Files:**
- Create: `components/mini/telegram-webapp.tsx` + 测试
- Create: `components/mini/back-button.tsx`、`components/mini/main-button.tsx` + 测试
- Create: `app/mini/layout.tsx`、`app/mini/mini.css`

**Interfaces:**
- Produces: `useTelegram(): { ready: boolean; colorScheme: "light" | "dark"; haptic(kind: "impact" | "success" | "warning"): void }`
- Produces: `<TelegramProvider>`（client，负责 `ready()`、`expand()`、换 cookie、主题订阅）
- Produces: `<BackButton onClick={() => void}>`、`<MainButton text={string} onClick={() => void} disabled?: boolean>`（均渲染 `null`，只做副作用）

- [ ] **Step 1: 写失败测试（用假的 WebApp 对象）**

```ts
function fakeWebApp() {
  const handlers: Record<string, () => void> = {};
  return {
    initData: "stub",
    colorScheme: "light" as const,
    themeParams: { bg_color: "#ffffff", text_color: "#000000" },
    ready: vi.fn(), expand: vi.fn(),
    onEvent: vi.fn((e: string, h: () => void) => { handlers[e] = h; }),
    offEvent: vi.fn(),
    BackButton: { show: vi.fn(), hide: vi.fn(), onClick: vi.fn(), offClick: vi.fn() },
    MainButton: { setText: vi.fn(), show: vi.fn(), hide: vi.fn(), onClick: vi.fn(), offClick: vi.fn(), enable: vi.fn(), disable: vi.fn() },
    HapticFeedback: { impactOccurred: vi.fn(), notificationOccurred: vi.fn() },
    _fire: (e: string) => handlers[e]?.()
  };
}

it("unbinds the back button on unmount so the next page does not inherit it", () => {
  const wa = fakeWebApp();
  const onClick = vi.fn();
  const { unmount } = render(<BackButton onClick={onClick} />, { wrapper: withFakeTelegram(wa) });
  expect(wa.BackButton.show).toHaveBeenCalled();
  unmount();
  expect(wa.BackButton.offClick).toHaveBeenCalled();
  expect(wa.BackButton.hide).toHaveBeenCalled();
});

it("renders children before Telegram is available and does not crash", () => {
  render(<TelegramProvider><p>hello</p></TelegramProvider>);   // no window.Telegram at all
  expect(screen.getByText("hello")).toBeInTheDocument();
});

it("follows a colorScheme change", () => { /* wa.colorScheme = "dark"; wa._fire("themeChanged"); 断言 data-theme */ });
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run components/mini/`
Expected: FAIL

- [ ] **Step 3: 实现壳层**

`TelegramProvider`（`"use client"`）：

1. `useEffect` 内读 `window.Telegram?.WebApp`；不存在就保持 `ready=false` 并照常渲染 children
   （**这一帧必须能渲染**，否则服务端渲染出的 HTML 与客户端不一致会水合错乱）;
2. 调 `ready()`、`expand()`；
3. 若尚无 mini cookie，`POST /api/mini/session`（body 带 `initData`），成功后 `router.refresh()`；
4. 订阅 `themeChanged`，把 `colorScheme` 写到 `<html data-theme>`；卸载时 `offEvent`。

`BackButton` / `MainButton` 渲染 `null`，在 `useEffect` 里 `show/setText/onClick`，
**返回清理函数做 `offClick` 与 `hide`**——这是测试里专门盯住的一条。

- [ ] **Step 4: 写 layout 与样式**

`app/mini/layout.tsx` 包 `TelegramProvider`，引入 `mini.css`；`mini.css` 只做两件事：
把 Telegram 的 `themeParams` 映射到既有的背景/前景变量，以及移动端的间距与安全区
（`env(safe-area-inset-bottom)`），**不重定义卡片、徽标与字体变量**。

- [ ] **Step 5: 运行并提交**

Run: `npx vitest run components/mini/ && npm run typecheck && npm run lint`

```bash
git add components/mini app/mini
git commit -m "feat(mini): Telegram shell with native back/main buttons and theme following"
```

---

### Task 3: 库列表、检索与筛选

**Files:**
- Create: `app/mini/page.tsx`、`app/mini/mini-filters.tsx` + 测试

**Interfaces:**
- Consumes: Task 2 的 `TelegramProvider`；`listLibrary`、`libraryStats`、`allTags`、`scenarioStats`、`embedSearchQuery`、`matchScenarios`、`parseLibraryParams`（全部来自现有 web 页面同一套）
- Produces: 行链接指向 `/mini/library/<id>`

- [ ] **Step 1: 写失败测试**

```ts
it("lists cards with serial, score and at most three tags", async () => { /* 渲染 page 的纯函数部分并断言 */ });
it("keeps the current filters in the row links so Back returns to the same view", async () => {
  // 行链接必须带上当前的 q/type/scenario 查询串，否则 BackButton 回到的是未筛选的列表
});
it("shows an empty state instead of a blank screen when nothing matches", async () => {});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run app/mini/`
Expected: FAIL

- [ ] **Step 3: 实现列表页**

照抄 `app/library/page.tsx` 的取数链路（`parseLibraryParams` → `matchScenarios` /
`embedSearchQuery` → `listLibrary`），**不要写第二套检索**。版面按移动端单列：
顶部搜索框 + 统计数字，其下筛选 chips 横向滚动，再下是卡片行
（编号 · 标题 · 评分 · 最多 3 个标签 + `+N`，与 M3.8 的列表一致）。

- [ ] **Step 4: 运行，确认通过；提交**

Run: `npx vitest run app/mini/ && npm run build`

```bash
git add app/mini
git commit -m "feat(mini): library list with search and filters"
```

---

### Task 4: 详情页、待决页与全部写操作

**Files:**
- Create: `app/mini/library/[id]/page.tsx`、`app/mini/review/page.tsx`
- Create: `components/mini/mini-actions.tsx` + 测试

**Interfaces:**
- Consumes: `getCapabilityDetail`、`listPending`；`app/actions.ts` 的 `decideAction`、`editSuggestionAction`、`setProgressAction`、`rerunAction`、`deepAnalysisAction`、`setStatusAction`、`softDeleteAction`
- Consumes: Task 2 的 `<BackButton>`、`<MainButton>`、`useTelegram().haptic`

- [ ] **Step 1: 写失败测试**

```ts
it("fires a notification haptic after a decision succeeds, and none when it conflicts", async () => {});
it("freezes the control on CONFLICT instead of retrying with a stale lock token", async () => {
  // 与 web 的 DetailActions 同一条纪律：冲突不重试、不覆盖
});
it("binds MainButton to the primary action for the card's current state", async () => {
  // 未开始自研 → 「开始自研」；已在自研中 → 不再是同一个主按钮
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run components/mini/mini-actions.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

详情页内容顺序与 web 一致：深度分析（若有）置顶 → 结构化摘要 → 价值信号 → 怎么用 →
来源事实 → 自研进度与笔记 → 原始投递（折叠）。写操作**直接调用现有 server actions**，
乐观锁的处理照搬 `components/capability/progress-control.tsx` 的做法（冲突即冻结，等刷新）。

`<BackButton>` 在详情页与待决页注册，点击走 `router.back()`。
`<MainButton>` 只绑当前页最主要的一个动作；其余动作用页面内按钮。
成功的裁决 / 改进度调 `haptic("success")`，失败调 `haptic("warning")`。

- [ ] **Step 4: 运行，确认通过；提交**

Run: `npm test && npm run typecheck && npm run lint && npm run build`

```bash
git add app/mini components/mini
git commit -m "feat(mini): detail and review pages with the full write loop"
```

---

### Task 5: bot 入口、真机走查与验证文档

**Files:**
- Modify: `lib/telegram/commands.ts`（菜单按钮）、`lib/telegram/format.ts`（卡片按钮）
- Create: `docs/aj-301-verification.md`

- [ ] **Step 1: 写失败测试**

```ts
it("sets a menu button that opens the mini app", async () => {
  // setChatMenuButton 的请求体： { menu_button: { type: "web_app", text: "能力库", web_app: { url: ".../mini" } } }
  // 断言打到 API 的 HTTP body，而不是断言假对象收到的参数（M3 的教训：
  // 只断言 fake 的入参会让“按钮其实没设上”这类缺陷通过）
});

it("renders the card's open button as a web_app button pointing at that card", () => {
  const markup = formatResult(input).replyMarkup;
  const button = markup.inline_keyboard.flat().find((b) => "web_app" in b);
  expect(button.web_app.url).toBe("https://caphub.agentjoey.ai/mini/library/cap_1");
  // 三处卡片渲染（裁决卡 / 待复核卡 / 自研卡）都带这个按钮，测试要覆盖不止一处
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run lib/telegram/`
Expected: FAIL

- [ ] **Step 3: 实现**

`commands.ts` 在启动写命令菜单时一并调 `setChatMenuButton`；`format.ts` 把原「🔗 去 web」
换成 `web_app` 按钮。URL 用**现有的** `publicBaseUrl()`（`lib/telegram/capture.ts` 导出，
读 `PUBLIC_BASE_URL`，缺省 `https://caphub.agentjoey.ai`，并已处理尾斜杠）拼成
`${publicBaseUrl()}/mini/library/<id>`。`format.ts` 里已有一个模块私有的 `libraryLink(id)`
指向 `/library/<id>`——**三处**「去 web」按钮都用它，改时三处一起改，或在其旁新增
`miniLink(id)` 并替换这三处的用法，不要只改一处。
`web_app` 内联按钮只在私聊可用——本项目只有私聊，符合。
**历史消息里的旧 URL 按钮不迁移**，行为不变。

- [ ] **Step 4: 上线与真机走查**

先由 Human 在 Railway 的 `web` 服务加 `TELEGRAM_BOT_TOKEN`（值与 worker 相同），并调长
Cloudflare Access 邮箱策略的 session duration。部署后在 iPhone Telegram 上走一遍：

- 菜单按钮打开 `/mini` → 首次会要求过一次 Access 邮箱验证码 → 列表可见
- 搜索中文关键词有命中；筛选 chips 生效
- 从卡片按钮直接打开某张卡的详情
- 裁决一张待决卡；改一张卡的自研进度；两者都有触感反馈
- Telegram 的返回键能从详情回到列表，且回到的是**原来的筛选状态**
- 切换手机深浅色，Mini App 跟随
- 真机截图（`scripts/shot.mjs` 进不了 WebView，只能手机截图）

- [ ] **Step 5: 写验证文档并提交**

`docs/aj-301-verification.md` 记录：上线步骤、走查逐条结果、真机截图、实际遗留。

```bash
git add lib/telegram docs/aj-301-verification.md
git commit -m "feat(mini): bot entry points for the mini app"
```

## Self-review

- **Spec 覆盖**：§2 范围 → T3/T4；§3 鉴权 → T1（含守卫收口）；§4 入口 → T5；§5 页面 → T3/T4；
  §6 交互 → T2/T4；§7 测试 → 各任务测试步骤 + T5 走查；§8 Human 操作 → T5 Step 4；§9 风险见下。
- **最容易出事的三处，已在计划里点名**：`initData` 服务端拿不到（Global Constraints + T1）；
  server action POST 到页面路径因而守卫能一处收口（T1 Step 7）；原生按钮不解绑会串页（T2 Step 3 + 测试）。
- **风险**：iOS 键盘顶飞底部主按钮（T2 的安全区与 `viewportStableHeight`）；两处版面共用一套数据但分别维护（T3/T4 都复用现有取数与 actions，降低漂移）；WebView 内的 Access 登录体验（T5 走查确认，若不可接受需 Human 重新决定，不在实施中自行降级）。
