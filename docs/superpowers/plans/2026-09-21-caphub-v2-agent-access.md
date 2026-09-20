# Caphub v2 — Agent 接入（AJ-296）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Joey 的其他 agent 通过远程 MCP 查 Caphub 能力库，并把自研成果回写。

**Architecture:** 在现有 Next `web` 服务上加一条 `POST /api/mcp`，手写一层无状态 JSON-RPC（MCP Streamable HTTP 的 POST+JSON 子集），工具实现放在 `lib/mcp/`，全部调用现有的 `lib/library/queries.ts` 与 `lib/library/actions.ts`——web、Telegram、MCP 三个入口共用同一套查询与同一套乐观锁。鉴权复用 Cloudflare Access，新增 service token 身份与白名单。

**Tech Stack:** Next 16 App Router（route handler 收 Web `Request`）、TypeScript、pg、Zod 4、Vitest、Neon（迁移 013）。

**Spec:** `docs/superpowers/specs/2026-09-21-caphub-v2-agent-access-design.md`

## Global Constraints

- **鉴权 fail closed**：`CF_ACCESS_SERVICE_TOKEN_CN` 未配置时，`/api/mcp` 一律 401。绝不退化成"验签通过即放行"。
- **人类与机器身份不串用**：`/api/mcp` 只认 `common_name`；其余路径只认 `email`。
- **乐观锁纪律**：任何 `updated_at` 比较必须写成 `date_trunc('milliseconds', updated_at) = $n::timestamptz`（node-postgres 返回毫秒精度，微秒比较会静默不生效）。
- **中文检索**：任何存放正文的列都必须同时进入全文生成列**和** `listLibrary` 的 ILIKE 腿——`simple` 配置把一整串中文切成一个 token，中文搜索实际靠的是 ILIKE。
- **只读工具只返回 `verdict='keep' AND status='active' AND deleted_at IS NULL` 的卡**。
- **绝不返回图片二进制**，只给编号与 web 链接。
- **日志不含 token、密钥、图片内容**。
- **agent 不得裁决、改分类、退役、删除**；`set_build_progress` 不接受 `todo` / `planned`。
- 提交信息结尾附带：`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`。

## File Structure

| 文件 | 职责 |
|---|---|
| `lib/auth/access.ts`（改） | 验签后返回 `{ email, commonName }`，不再强制要求 email |
| `lib/auth/guard.ts`（改） | 按路径分流：`/api/mcp` 走 service-token 白名单，其余走 email |
| `lib/db/migrations/013_build_notes.sql`（新） | `build_notes` 列 + 重建全文生成列与 GIN 索引 |
| `lib/library/build-notes.ts`（新） | 笔记的类型、校验与追加 SQL（唯一的写笔记入口） |
| `lib/mcp/tools.ts`（新） | 7 个工具的实现，纯函数，入参出参都是普通对象 |
| `lib/mcp/schema.ts`（新） | 工具的 JSON Schema 定义（`tools/list` 用）与入参校验 |
| `lib/mcp/rpc.ts`（新） | 无状态 JSON-RPC 分发：`initialize` / `tools/list` / `tools/call` / `ping` |
| `app/api/mcp/route.ts`（新） | 薄路由，取 runtime，交给 `rpc.ts` |
| `components/capability/build-notes.tsx`（新） | 详情页笔记列表 |
| `docs/agent-access.md`（新） | 各客户端配置片段 + 贴进 CLAUDE.md 的用法说明 |

---

### Task 1: Access service token 身份与白名单

**Files:**
- Modify: `lib/auth/access.ts`（`verifyAccessJwt` 的返回值与 email 断言）
- Modify: `lib/auth/guard.ts`（按路径分流）
- Test: `lib/auth/access.test.ts`、`lib/auth/guard.test.ts`

**Interfaces:**
- Produces: `verifyAccessJwt(token, opts): Promise<{ email: string; commonName: string }>`（无 email 时 `email` 为 `""`，无 common_name 时 `commonName` 为 `""`；两者都空才抛 `ACCESS_IDENTITY_MISSING`）
- Produces: `guardRequest(request, env, deps)` 对 `/api/mcp` 的行为：无 `CF_ACCESS_SERVICE_TOKEN_CN` → 401；`commonName` 不等于它 → 401。

- [ ] **Step 1: 写失败测试（access.ts）**

该文件已有一个 `setup()` 辅助，返回 `{ fetchFn, sign, teamDomain }`（`sign(claims)` 用测试自己生成的
密钥对签名，JWKS 由 `fetchFn` 假装返回）。照抄这套，不要新造：

```ts
it("returns the common_name identity for a service-token JWT with no email", async () => {
  const { fetchFn, sign, teamDomain } = await setup();
  const token = await sign({ aud: "aud1", iss: `https://${teamDomain}`, common_name: "caphub-agent" });
  await expect(verifyAccessJwt(token, { aud: "aud1", teamDomain, fetch: fetchFn }))
    .resolves.toEqual({ email: "", commonName: "caphub-agent" });
});

it("still rejects a JWT carrying neither email nor common_name", async () => {
  const { fetchFn, sign, teamDomain } = await setup();
  const token = await sign({ aud: "aud1", iss: `https://${teamDomain}` });
  await expect(verifyAccessJwt(token, { aud: "aud1", teamDomain, fetch: fetchFn }))
    .rejects.toThrow(/ACCESS_IDENTITY_MISSING/);
});
```

**同时要改既有用例**：该文件里现有的断言写成 `.resolves.toEqual({ email: "a@b.c" })`，返回值加上
`commonName` 之后它们会失败——把它们改成 `{ email: "a@b.c", commonName: "" }`。这不是"测试碍事所以放宽"，
而是返回值的契约确实变了。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run lib/auth/access.test.ts`
Expected: FAIL（现在抛 `ACCESS_EMAIL_MISSING`，且返回值只有 `email`）

- [ ] **Step 3: 改 access.ts**

把结尾的 email 断言改成：

```ts
const email = typeof payload.email === "string" ? payload.email : "";
const commonName = typeof payload.common_name === "string" ? payload.common_name : "";
if (!email && !commonName) throw new Error("ACCESS_IDENTITY_MISSING");
return { email, commonName };
```

调用处若有 `.email` 解构，保持可用（返回对象是超集）。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run lib/auth/access.test.ts`
Expected: PASS

- [ ] **Step 5: 写守卫测试（guard.test.ts）**

该文件已有 `ENV` 常量与 `request({ headers })` 辅助（后者固定打在 `/api/captures` 上），
所以只要加一个同形状、改路径的辅助——不要另起一套：

```ts
const mcp = (headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/mcp", { method: "POST", headers });
const MCP_ENV = { ...ENV, CF_ACCESS_SERVICE_TOKEN_CN: "caphub-agent" };

it("401s on /api/mcp when no service-token common name is configured", async () => {
  const verify = vi.fn().mockResolvedValue({ email: "", commonName: "caphub-agent" });
  const res = await guardRequest(mcp({ "cf-access-jwt-assertion": "t" }), ENV, { verify });
  expect(res.status).toBe(401);
});

it("401s on /api/mcp when the common name does not match the allowlist", async () => {
  const verify = vi.fn().mockResolvedValue({ email: "", commonName: "someone-elses-token" });
  const res = await guardRequest(mcp({ "cf-access-jwt-assertion": "t" }), MCP_ENV, { verify });
  expect(res.status).toBe(401);
});

it("lets the configured service token through on /api/mcp", async () => {
  const verify = vi.fn().mockResolvedValue({ email: "", commonName: "caphub-agent" });
  const res = await guardRequest(mcp({ "cf-access-jwt-assertion": "t" }), MCP_ENV, { verify });
  expect(res.status).not.toBe(401);
});

it("401s on /api/mcp for a human email JWT", async () => {
  const verify = vi.fn().mockResolvedValue({ email: "theagentjoey@gmail.com", commonName: "" });
  const res = await guardRequest(mcp({ "cf-access-jwt-assertion": "t" }), MCP_ENV, { verify });
  expect(res.status).toBe(401);
});

it("401s on a normal page for a service-token JWT", async () => {
  const verify = vi.fn().mockResolvedValue({ email: "", commonName: "caphub-agent" });
  const res = await guardRequest(new NextRequest("http://localhost/library"), MCP_ENV, { verify });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 6: 运行，确认失败**

Run: `npx vitest run lib/auth/guard.test.ts`
Expected: FAIL

- [ ] **Step 7: 改 guard.ts**

在 `verify` 成功之后按路径分流（`ACCESS_BYPASS` 的开发分支保持不变）：

```ts
const identity = await verify(token, { aud, teamDomain });
const isMcp = request.nextUrl.pathname === "/api/mcp";
if (isMcp) {
  const expected = env.CF_ACCESS_SERVICE_TOKEN_CN?.trim();
  // fail closed: 不配置白名单就谁也别想进来 —— 只验签的话，同一个 Access team
  // 里任何 service token 都能打这条路由。
  if (!expected || identity.commonName !== expected) return unauthorized();
} else if (!identity.email) {
  return unauthorized();
}
return NextResponse.next();
```

- [ ] **Step 8: 运行全部鉴权测试**

Run: `npx vitest run lib/auth/`
Expected: PASS（含既有用例）

- [ ] **Step 9: 提交**

```bash
git add lib/auth
git commit -m "feat(auth): accept Access service-token identity on /api/mcp only"
```

---

### Task 2: 迁移 013 — `build_notes`

**Files:**
- Create: `lib/db/migrations/013_build_notes.sql`
- Create: `lib/library/build-notes.ts` + `lib/library/build-notes.test.ts`
- Modify: `lib/library/queries.ts`（`CapabilityRow` / `CapabilityDetail` 取出笔记；ILIKE 腿加入笔记）
- Test: `lib/library/queries.test.ts`

**Interfaces:**
- Produces: `export interface BuildNote { at: string; by: string; text: string }`
- Produces: `export const MAX_NOTE_TEXT = 2000`
- Produces: `export function normalizeNote(input: { by: unknown; text: unknown }): BuildNote | null`（非法返回 null；`by` 截断到 40 字，缺省 `"agent"`；`text` trim 后必须非空且 ≤ 2000）
- Produces: `export async function appendBuildNote(pool, input: { id: string; expectedUpdatedAt: string; note: BuildNote }): Promise<ActionResult>`
- Produces: `CapabilityDetail.buildNotes: BuildNote[]`

- [ ] **Step 1: 写迁移**

```sql
-- M4 子项目 1（AJ-296）：agent 回写的自研实现笔记。追加式，每条 { at, by, text }；
-- `by` 是客户端自报的 agent 名，只用于显示，真正的身份是 Access service token。
ALTER TABLE caphub_v2.capabilities
  ADD COLUMN build_notes jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 笔记要能被搜到。生成列表达式不能就地修改，只能 drop 后重建（会连带 drop 掉
-- capabilities_search 这个 GIN 索引，下面重建）——与 012 的做法一致。
ALTER TABLE caphub_v2.capabilities DROP COLUMN search;
DROP FUNCTION caphub_v2.capability_search_text(text, text, text[], jsonb, jsonb);

-- 保持 IMMUTABLE：每个操作数都只是对本函数自身参数做标准 SQL 的强转与拼接
-- （jsonb::text / array_to_string / coalesce / ||），没有目录查询，也不依赖会话或 locale。
CREATE FUNCTION caphub_v2.capability_search_text(title text, summary text, tags text[], playbook jsonb, summary_points jsonb, build_notes jsonb) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(array_to_string(tags,' '),'') || ' ' || coalesce(playbook::text,'') || ' ' || coalesce(summary_points::text,'') || ' ' || coalesce(build_notes::text,'') $$;

ALTER TABLE caphub_v2.capabilities ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('simple'::regconfig, caphub_v2.capability_search_text(title, summary, tags, playbook, summary_points, build_notes))
) STORED;
CREATE INDEX capabilities_search ON caphub_v2.capabilities USING gin(search);

-- 不需要 GRANT：caphub_v2_app 在 001 就有表级 SELECT/INSERT/UPDATE，新列默认继承表级授权
-- （与 007/008/009/010/011/012 相同）。
```

- [ ] **Step 2: 写 build-notes 的失败测试**

```ts
describe("normalizeNote", () => {
  it("fills a default author and trims", () => {
    expect(normalizeNote({ by: "  ", text: "  用 gsap-skills 直接装上了  " }))
      .toEqual({ at: expect.any(String), by: "agent", text: "用 gsap-skills 直接装上了" });
  });
  it("rejects an empty or over-long note", () => {
    expect(normalizeNote({ by: "claude", text: "   " })).toBeNull();
    expect(normalizeNote({ by: "claude", text: "字".repeat(2001) })).toBeNull();
  });
  it("accepts a note exactly at the cap", () => {
    expect(normalizeNote({ by: "claude", text: "字".repeat(2000) })?.text).toHaveLength(2000);
  });
  it("truncates an over-long author name", () => {
    expect(normalizeNote({ by: "a".repeat(80), text: "x" })?.by).toHaveLength(40);
  });
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run lib/library/build-notes.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 build-notes.ts**

```ts
export const MAX_NOTE_TEXT = 2000;
const MAX_NOTE_BY = 40;

export interface BuildNote { at: string; by: string; text: string }

export function normalizeNote(input: { by: unknown; text: unknown }): BuildNote | null {
  if (typeof input.text !== "string") return null;
  const text = input.text.trim();
  if (text.length === 0 || text.length > MAX_NOTE_TEXT) return null;
  const rawBy = typeof input.by === "string" ? input.by.trim() : "";
  const by = (rawBy === "" ? "agent" : rawBy).slice(0, MAX_NOTE_BY);
  return { at: new Date().toISOString(), by, text };
}
```

追加写入（与既有写者同一套乐观锁；`||` 是 jsonb 数组拼接，纯追加）：

```ts
export async function appendBuildNote(
  pool: Pool,
  input: { id: string; expectedUpdatedAt: string; note: BuildNote },
  locale: Locale = "zh"
): Promise<ActionResult> {
  const dict = getDict(locale).actions;
  if (!isNonEmptyString(input.id) || !isParsableTimestamp(input.expectedUpdatedAt)) return invalid(dict.invalid);
  const r = await pool.query<{ updated_at: Date }>(
    `UPDATE caphub_v2.capabilities
        SET build_notes = build_notes || $3::jsonb, updated_at = now()
      WHERE id = $1 AND date_trunc('milliseconds', updated_at) = $2::timestamptz
        AND deleted_at IS NULL AND verdict = 'keep'
      RETURNING updated_at`,
    [input.id, input.expectedUpdatedAt, JSON.stringify([input.note])]);
  if (r.rows[0]) return { ok: true, updatedAt: r.rows[0].updated_at.toISOString() };
  return missingOrConflict(pool, input.id, locale);
}
```

`missingOrConflict` / `invalid` / `isNonEmptyString` / `isParsableTimestamp` 目前是 `lib/library/actions.ts` 的模块私有函数：把它们提到 `lib/library/action-result.ts` 并让 `actions.ts` 与 `build-notes.ts` 都从那里引入，**不要复制一份**。

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run lib/library/build-notes.test.ts`
Expected: PASS

- [ ] **Step 6: 把笔记接进查询与 ILIKE 腿**

`lib/library/queries.ts`：模块私有的 `CARD_COLUMNS` 常量增加 `cb.build_notes AS "buildNotes"`，`CapabilityDetail` 增加 `buildNotes: BuildNote[]`（`getCapabilityDetail` 里映射，空值兜底成 `[]`）；ILIKE 腿改为：

```ts
const ilikeMatch = `(cb.title ILIKE $${ilikeIdx} OR cb.summary ILIKE $${ilikeIdx} OR cb.summary_points::text ILIKE $${ilikeIdx} OR cb.build_notes::text ILIKE $${ilikeIdx} OR EXISTS (SELECT 1 FROM unnest(cb.tags) tg WHERE tg ILIKE $${ilikeIdx}))`;
```

- [ ] **Step 7: 写检索回归测试**

在 `lib/library/queries.test.ts` 里断言生成的 SQL 覆盖笔记。该文件既有的写法是用 `recorder(...)`
记录 pool 收到的 SQL 再对文本做断言，照抄那套：

```ts
it("matches a Chinese word that only appears in a build note", async () => {
  const { pool, calls } = recorder([[], [{ total: "0" }]]);
  await listLibrary(pool, { q: "踩坑", page: 1 });
  // simple 配置会把一整串中文切成一个 token，中文搜索实际靠的是 ILIKE 这条腿
  expect(calls[0].text).toMatch(/cb\.build_notes::text ILIKE \$\d+/);
});
```

- [ ] **Step 8: 运行全部测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add lib/db/migrations/013_build_notes.sql lib/library
git commit -m "feat(library): build_notes column, append-only writer, search coverage"
```

---

### Task 3: 只读工具

**Files:**
- Create: `lib/mcp/tools.ts` + `lib/mcp/tools.test.ts`
- Create: `lib/mcp/serial.ts`（编号 → 卡片定位）

**Interfaces:**
- Consumes: `listLibrary`、`listTodoCapabilities`、`libraryStats`、`getCapabilityDetail`、`embedSearchQuery`、`matchScenarios`、`loadScenarios`、`parseSerialQuery`、`formatSerial`
- Produces: `export interface ToolDeps { pool: Pool; geminiApiKey?: string }`
- Produces: `export async function resolveSerial(pool, serial: string): Promise<{ id: string; captureId: string; updatedAt: string } | null>`
- Produces: `searchCapabilities(deps, { query, limit?, type?, tags?, usage? })`、`getCapability(deps, { serial })`、`listToBuild(deps, { limit? })`、`listRecent(deps, { limit? })`、`getStats(deps)`，返回值都是可 JSON 序列化的普通对象

- [ ] **Step 1: 写失败测试**

```ts
const fakePool = (rows: unknown[]) => ({ query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) });

it("caps the result count at 25 even when asked for more", async () => {
  const res = await searchCapabilities({ pool: fakePool([]) as never }, { query: "动效", limit: 999 });
  expect(res.items.length).toBeLessThanOrEqual(25);
});

it("resolves a serial like SKL-0031 to a card id", async () => {
  const pool = fakePool([{ id: "cap_1", capture_id: "cpt_1", updated_at: new Date("2026-09-21T00:00:00.000Z") }]);
  await expect(resolveSerial(pool as never, "SKL-0031"))
    .resolves.toEqual({ id: "cap_1", captureId: "cpt_1", updatedAt: "2026-09-21T00:00:00.000Z" });
});

it("returns null for a serial that is not a serial", async () => {
  await expect(resolveSerial(fakePool([]) as never, "不是编号")).resolves.toBeNull();
});

it("never returns image bytes", async () => {
  const res = await getCapability(deps, { serial: "SKL-0031" });
  expect(JSON.stringify(res)).not.toMatch(/thumb_key|image\/(png|jpeg)|base64/);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run lib/mcp/tools.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 serial.ts**

```ts
/** 编号（SKL-0031 / #31）→ 卡片定位。只认 keep + active + 未删除的卡。 */
export async function resolveSerial(pool: Q, serial: string): Promise<{ id: string; captureId: string; updatedAt: string } | null> {
  const n = parseSerialQuery(serial);
  if (n === null) return null;
  const r = await pool.query<{ id: string; capture_id: string; updated_at: Date }>(
    `SELECT id, capture_id, updated_at FROM caphub_v2.capabilities
      WHERE serial = $1 AND verdict = 'keep' AND status = 'active' AND deleted_at IS NULL`, [n]);
  const row = r.rows[0];
  return row ? { id: row.id, captureId: row.capture_id, updatedAt: row.updated_at.toISOString() } : null;
}
```

- [ ] **Step 4: 实现只读工具**

搜索完全照抄 `lib/telegram/search.ts` 的复用链路（`parseSerialQuery` → `matchScenarios` / `embedSearchQuery` → `listLibrary`），不要写第二套检索：

```ts
export const MAX_ITEMS = 25;
const clamp = (n: unknown, fallback: number) =>
  Math.min(MAX_ITEMS, Math.max(1, Number.isInteger(n) ? (n as number) : fallback));

export async function searchCapabilities(deps: ToolDeps, input: { query: string; limit?: number; type?: CapabilityType; tags?: string[]; usage?: "integrate" | "reference" }) {
  const query = input.query.trim();
  const scenarios = await loadScenarios(deps.pool);
  const isSerial = parseSerialQuery(query) !== null;
  const matchedScenarioSlugs = isSerial ? [] : matchScenarios(query, scenarios);
  const queryEmbedding = isSerial ? null : await embedSearchQuery(deps.geminiApiKey, query);
  const filter: LibraryFilter = { q: query, page: 1, ...(input.type ? { types: [input.type] } : {}), ...(input.tags?.length ? { tags: input.tags } : {}), ...(input.usage ? { usage: input.usage } : {}) };
  const { items, total } = await listLibrary(deps.pool, filter, { queryEmbedding, matchedScenarioSlugs });
  return { total, items: items.slice(0, clamp(input.limit, 10)).map(toBrief) };
}
```

`toBrief(row)` 只输出：`serial`（`formatSerial`）、`title`、`type`、`usage`、`score`、`tags`、`summary`、`summaryPoints`、`url`（`https://caphub.agentjoey.ai/library/<id>`）。
`getCapability` 用 `resolveSerial` + `getCapabilityDetail`，输出在 brief 基础上再加 `signals`、`playbook`、`sourceFacts`、`scenarios`、`openQuestions`、`deepAnalysis`、`progress`、`progressLink`、`buildNotes`。
`listToBuild` 调 `listTodoCapabilities`；`listRecent` 调 `listLibrary({ page: 1 })`；`getStats` 调 `libraryStats`。
**所有输出都不得包含 `thumbKey`、`captureId` 之外的存储键，不得包含任何二进制。**

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run lib/mcp/`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add lib/mcp
git commit -m "feat(mcp): read-only capability tools over the existing query layer"
```

---

### Task 4: 写工具

**Files:**
- Modify: `lib/mcp/tools.ts` + `lib/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `resolveSerial`、`setProgress`、`appendBuildNote`、`normalizeNote`
- Produces: `setBuildProgress(deps, { serial, progress, link?, note?, by? })`、`appendNote(deps, { serial, note, by? })`，返回 `{ ok: true, serial, progress?, noteCount? }` 或 `{ ok: false, error: string }`

- [ ] **Step 1: 写失败测试**

```ts
it("refuses to move progress back to todo or planned", async () => {
  await expect(setBuildProgress(deps, { serial: "SKL-0031", progress: "todo" }))
    .resolves.toMatchObject({ ok: false });
  await expect(setBuildProgress(deps, { serial: "SKL-0031", progress: "planned" }))
    .resolves.toMatchObject({ ok: false });
});

it("writes the progress and appends the note in the same call", async () => {
  // setProgress 成功后返回新的 updatedAt，笔记必须用那个新值做锁，而不是最初读到的那个
  const res = await setBuildProgress(deps, { serial: "SKL-0031", progress: "done", note: "装上就能用", by: "claude" });
  expect(res).toMatchObject({ ok: true, progress: "done", noteCount: 1 });
});

it("reports a conflict instead of overwriting", async () => {
  // setProgress 返回 { ok: false, reason: "CONFLICT" }
  await expect(setBuildProgress(deps, { serial: "SKL-0031", progress: "done" }))
    .resolves.toMatchObject({ ok: false, error: expect.stringContaining("别处") });
});

it("reports not-found for an unknown serial", async () => {
  await expect(appendNote(deps, { serial: "SKL-9999", note: "x" })).resolves.toMatchObject({ ok: false });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run lib/mcp/tools.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
const AGENT_PROGRESS = ["building", "done", "dropped"] as const;

export async function setBuildProgress(deps: ToolDeps, input: { serial: string; progress: string; link?: string | null; note?: string; by?: string }) {
  if (!(AGENT_PROGRESS as readonly string[]).includes(input.progress)) {
    return { ok: false as const, error: "progress 只能是 building / done / dropped；排期（todo / planned）由人来定" };
  }
  const card = await resolveSerial(deps.pool, input.serial);
  if (!card) return { ok: false as const, error: `找不到编号 ${input.serial}` };
  const r = await setProgress(deps.pool, { id: card.id, expectedUpdatedAt: card.updatedAt, progress: input.progress as Progress, link: input.link ?? null });
  if (!r.ok) return { ok: false as const, error: r.message };
  if (!input.note) return { ok: true as const, serial: input.serial, progress: input.progress };
  // setProgress 已经把 updated_at 推到新值了，笔记必须拿这个新值做锁，
  // 否则同一次调用里的第二次写必然自己撞自己。
  const note = normalizeNote({ by: input.by, text: input.note });
  if (!note) return { ok: true as const, serial: input.serial, progress: input.progress, noteSkipped: "笔记为空或超过 2000 字" };
  const n = await appendBuildNote(deps.pool, { id: card.id, expectedUpdatedAt: r.updatedAt, note });
  return n.ok
    ? { ok: true as const, serial: input.serial, progress: input.progress, noteCount: 1 }
    : { ok: false as const, error: n.message };
}
```

`appendNote` 同样是 `resolveSerial` → `normalizeNote` → `appendBuildNote`，不改进度。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run lib/mcp/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add lib/mcp
git commit -m "feat(mcp): build-progress and note write tools"
```

---

### Task 5: JSON-RPC 分发与路由

**Files:**
- Create: `lib/mcp/schema.ts`、`lib/mcp/rpc.ts` + `lib/mcp/rpc.test.ts`
- Create: `app/api/mcp/route.ts`

**Interfaces:**
- Consumes: Task 3 / 4 的 7 个工具函数
- Produces: `export async function handleMcpRequest(deps: ToolDeps, request: Request): Promise<Response>`

**背景（实现者需要知道）**：MCP 的 Streamable HTTP 传输在不需要服务端推送时，就是"POST 一个 JSON-RPC 请求、回一个 JSON 响应"。本期只实现这个子集，不引入 SDK——我们没有流式或会话需求，而 SDK 的 transport 吃的是 Node 的 `req`/`res`，与 Next 的 Web `Request` 之间还要垫一层适配。要实现的方法只有四个：`initialize`、`notifications/initialized`、`tools/list`、`tools/call`，外加 `ping`。

- [ ] **Step 1: 写失败测试**

```ts
const call = (body: unknown) => handleMcpRequest(deps, new Request("https://x/api/mcp", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
}));

it("answers initialize with the client's protocol version and a tools capability", async () => {
  const res = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude", version: "1" } } });
  const body = await res.json();
  expect(body.result.protocolVersion).toBe("2025-06-18");
  expect(body.result.capabilities.tools).toBeDefined();
  expect(body.result.serverInfo.name).toBe("caphub");
});

it("accepts the initialized notification with 202 and no body", async () => {
  const res = await call({ jsonrpc: "2.0", method: "notifications/initialized" });
  expect(res.status).toBe(202);
  expect(await res.text()).toBe("");
});

it("lists all seven tools with input schemas", async () => {
  const body = await (await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  expect(body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
    "append_build_note", "get_capability", "get_stats", "list_recent", "list_to_build", "search_capabilities", "set_build_progress"
  ]);
  for (const tool of body.result.tools) expect(tool.inputSchema.type).toBe("object");
});

it("returns -32601 for an unknown method", async () => {
  const body = await (await call({ jsonrpc: "2.0", id: 3, method: "tools/nope" })).json();
  expect(body.error.code).toBe(-32601);
});

it("returns a tool error as isError content, not a transport error", async () => {
  const body = await (await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_capability", arguments: { serial: "SKL-9999" } } })).json();
  expect(body.result.isError).toBe(true);
  expect(body.error).toBeUndefined();
});

it("rejects a malformed body with -32700", async () => {
  const res = await handleMcpRequest(deps, new Request("https://x/api/mcp", { method: "POST", body: "not json" }));
  expect((await res.json()).error.code).toBe(-32700);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run lib/mcp/rpc.test.ts`
Expected: FAIL

- [ ] **Step 3: 写 schema.ts**

每个工具一条 `{ name, description, inputSchema }`。描述要写给 agent 看，说清什么时候用，例如：

```ts
export const TOOL_DEFS = [
  {
    name: "search_capabilities",
    description: "用自然语言在 Joey 的能力库里找相关能力（技能 / 工具 / 模型 / 提示词 / 经验）。开始做一个新功能、选型、或者怀疑'这事是不是已经有现成方案'时先查这里。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "自然语言描述，例如'网页滚动动效'" },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
        type: { type: "string", enum: ["skill", "experience", "plugin", "prompt", "tool", "model", "other"] },
        tags: { type: "array", items: { type: "string" } },
        usage: { type: "string", enum: ["integrate", "reference"] }
      },
      required: ["query"]
    }
  },
  // …其余六个同构
] as const;
```

- [ ] **Step 4: 写 rpc.ts**

```ts
const PROTOCOL_FALLBACK = "2025-06-18";
const jsonRpc = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => Response.json({ jsonrpc: "2.0", id, error: { code, message } });
const toolResult = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const toolError = (message: string) => ({ content: [{ type: "text", text: message }], isError: true });

export async function handleMcpRequest(deps: ToolDeps, request: Request): Promise<Response> {
  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try { body = await request.json(); } catch { return rpcError(null, -32700, "parse error"); }
  const { id, method } = body;
  if (method === "notifications/initialized") return new Response(null, { status: 202 });
  switch (method) {
    case "initialize":
      return jsonRpc(id, {
        protocolVersion: typeof body.params?.protocolVersion === "string" ? body.params.protocolVersion : PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: "caphub", version: "2.0.0" }
      });
    case "ping": return jsonRpc(id, {});
    case "tools/list": return jsonRpc(id, { tools: TOOL_DEFS });
    case "tools/call": return jsonRpc(id, await callTool(deps, body.params));
    default: return rpcError(id, -32601, `unknown method: ${String(method)}`);
  }
}
```

`callTool` 按名字分发到 Task 3/4 的函数，入参先过 `schema.ts` 的校验；工具自身的失败（找不到编号、写冲突）返回 `toolError(...)`，**不要**变成 JSON-RPC 传输错误——MCP 客户端要能把它当成工具的回答读给模型听。每次调用打一行结构化日志：工具名、编号、ok、耗时，**不记参数正文、不记密钥**。

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run lib/mcp/rpc.test.ts`
Expected: PASS

- [ ] **Step 6: 写路由**

```ts
// app/api/mcp/route.ts
import { handleMcpRequest } from "../../../lib/mcp/rpc";
import { getRuntime } from "../../../lib/runtime";

export async function POST(request: Request): Promise<Response> {
  const { pool, config } = getRuntime();
  return handleMcpRequest({ pool, geminiApiKey: config.providers.geminiApiKey }, request);
}
```

鉴权由 `proxy.ts` 的 matcher 覆盖（Task 1 已在 `guardRequest` 里给这条路径加了白名单），**路由里不要再自己判一次身份**。

- [ ] **Step 7: 全量检查**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: 全绿

- [ ] **Step 8: 提交**

```bash
git add lib/mcp app/api/mcp
git commit -m "feat(mcp): stateless JSON-RPC endpoint at /api/mcp"
```

---

### Task 6: 详情页展示笔记

**Files:**
- Create: `components/capability/build-notes.tsx` + 测试
- Modify: `app/library/[id]/page.tsx`（挂到「自研进度」面板下方）
- Modify: `lib/i18n/dict-zh.ts` 与 `lib/i18n/dict-en.ts`（新增「自研笔记」区块标题；空态不渲染，所以不需要空态文案）

- [ ] **Step 1: 写失败测试**

```ts
it("renders nothing when there are no notes", () => {
  const { container } = render(<BuildNotes notes={[]} locale="zh" />);
  expect(container).toBeEmptyDOMElement();
});

it("lists notes newest first with author and time", () => {
  render(<BuildNotes locale="zh" notes={[
    { at: "2026-09-20T10:00:00.000Z", by: "claude", text: "先装了官方 skills" },
    { at: "2026-09-21T10:00:00.000Z", by: "codex", text: "补了 ScrollTrigger 的清理" }
  ]} />);
  const items = screen.getAllByRole("listitem");
  expect(items[0]).toHaveTextContent("补了 ScrollTrigger 的清理");
  expect(items[0]).toHaveTextContent("codex");
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run components/capability/build-notes.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现组件并挂进详情页**

沿用现有卡片区块的样式 token（参考 `components/capability/deep-analysis.tsx` 的分区写法），倒序渲染，作者与时间用弱化的小字。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run components/capability/`
Expected: PASS

- [ ] **Step 5: 截图**

```bash
node scripts/shot.mjs http://127.0.0.1:3000/library/<有笔记的卡片 id> .agent/screens/m4-agent/detail-notes-1440.png 1440 2 0
node scripts/shot.mjs http://127.0.0.1:3000/library/<同一张卡> .agent/screens/m4-agent/detail-notes-390.png 390 3 1
```

- [ ] **Step 6: 提交**

```bash
git add components/capability app/library lib/i18n .agent/screens/m4-agent
git commit -m "feat(web): show build notes under the self-build panel"
```

---

### Task 7: 接入文档

**Files:**
- Create: `docs/agent-access.md`
- Modify: `README.md`（加一行指向它）

- [ ] **Step 1: 写文档**

必须包含：

1. 三种客户端的配置片段（claude / codex / opencode），密钥一律写成 `<CF_ACCESS_CLIENT_ID>` 这样的占位符，**绝不写真实值**：

```bash
claude mcp add --transport http caphub https://caphub.agentjoey.ai/api/mcp \
  --header "CF-Access-Client-Id: <CF_ACCESS_CLIENT_ID>" \
  --header "CF-Access-Client-Secret: <CF_ACCESS_CLIENT_SECRET>"
```

2. 一段可以原样贴进全局 `CLAUDE.md` 的文字：

```markdown
## Caphub 能力库
开始一个新功能、做技术选型、或者怀疑"这事是不是已经有现成方案"时，先用 caphub 的
`search_capabilities` 查一下 Joey 的能力库。库里标为"参考自研"的能力，如果你按它动手实现了，
完成后用 `set_build_progress` 回写进度、仓库链接和一段实现笔记（踩了什么坑、与原能力的差异）。
不要用它做裁决、改分类或删除——那些只有 Joey 能做。
```

3. 七个工具的一句话说明表。
4. 排障：401 怎么查（白名单变量、Access 策略、header 名字）。

- [ ] **Step 2: 提交**

```bash
git add docs/agent-access.md README.md
git commit -m "docs(caphub): agent access setup and usage"
```

---

### Task 8: 上线与验收

- [ ] **Step 1: 临时 Neon branch 验证迁移**

建临时 branch，跑两遍迁移（第二次 applied 为空），插一条只出现在笔记里的中文词，确认 `listLibrary` 能搜到；验证后删除 branch。

- [ ] **Step 2: Human 在 Cloudflare Access 建 service token 与 Service Auth 策略**

Human 操作面板；把 token 的 common name 交给实现者，用于设置 Railway 上 `web` 的 `CF_ACCESS_SERVICE_TOKEN_CN`（这不是密钥，是名字）。Client Id / Secret 由 Human 自己保管并写进各客户端配置。

- [ ] **Step 3: 生产迁移 013**

在 worker 空闲时执行（重建生成列要拿 ACCESS EXCLUSIVE 锁，会排在 worker 的事务后面）。

- [ ] **Step 4: 合并部署**

先迁移、后合并（合并即自动部署）。

- [ ] **Step 5: 真机验收**

从另一台机器的 Claude Code：
- `search_capabilities("网页动效")` 能搜到 SKL-0031；
- `get_capability("SKL-0031")` 返回深度分析；
- `set_build_progress` 把某张待自研卡标成"自研中"并写一条笔记 → web 详情页可见、Telegram `/todo` 不再推送它；
- 故意去掉一个 header → 401。

- [ ] **Step 6: 写 `docs/m4-agent-access-verification.md`**

记录：迁移结果、真机验收逐条、实际遗留。

## Self-review

- **Spec 覆盖**：§2 鉴权 → Task 1；§3 工具面 → Task 3/4/5；§4 迁移与检索 → Task 2；§5 展示 → Task 6；§6 客户端接入 → Task 7；§7 日志与体量上限 → Task 3（`MAX_ITEMS`）与 Task 5（日志）；§8 测试与验收 → 各任务的测试步骤 + Task 8；§9 授权 → Task 8 Step 2/3。
- **两处最容易出事的地方，已在计划里点名**：`common_name` 白名单必须 fail closed（Task 1 Step 7），以及笔记必须同时进全文列和 ILIKE 腿（Task 2 Step 6）。
- **一处顺序陷阱**：`set_build_progress` 里 `setProgress` 会把 `updated_at` 推到新值，随后的笔记写入必须用返回的新值做锁，否则同一次调用会自己撞自己（Task 4 Step 3 已写明）。
- **风险**：不用官方 SDK 而手写 JSON-RPC 子集，若某客户端要求 SSE 响应，退路是给 `GET /api/mcp` 补一个 `text/event-stream` 的空流；本期不做。
