# Caphub v2 — 子项目 1（地基 + 管线）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建起独立仓库 `agentjoey/caphub`，在 Neon `caphub_v2` schema 上跑通「投递 → 队列 → A/B 管线 → CapabilityCard → 分级裁决」，并用 v1 的 14 条旧 capture 完成 A/B spike。

**Architecture:** Next.js 16 `web`（投递页 + API，Access JWT 校验）与单进程 `worker`（队列消费 + 保留期清扫）共用一个仓库和 `lib/`。管线是「step 列表」：每 step 输入结构化产物、输出 Zod 校验 JSON、写一行 `analysis_steps`；A（MiniMax 一条龙）与 B（MiniMax 看图 + Tavily + DeepSeek）只是 step 实现不同。所有配置来自环境变量。

**Tech Stack:** Next.js 16.3 App Router · React 19 · TypeScript 5 · Zod 4 · pg 8 · @aws-sdk/client-s3 · ai 7 + @ai-sdk/openai（MiniMax OpenAI 兼容端点）· sharp · tesseract.js · Vitest 4 · tsx · Railway

**Spec:** `docs/superpowers/specs/2026-09-19-caphub-v2-design.md`（§3–§5、§9.1 行 1、§9.2、§9.3、§10）

## Global Constraints

- 仓库：本地 `~/AgentWorks/CodeSpace/Caphub`，GitHub 私有 `agentjoey/caphub`。
- Neon project `caphub`（id `lingering-term-10256714`），数据库 `caphub`，新 schema **`caphub_v2`**；v1 schema `caphub` 只读，不改不删。
- 桶 `caphub-objects`，对象键 `sha256/<前2位>/<sha256>`（与 v1 相同，v1 图片直接复用）。
- 模型字面量固定：`MiniMax-M3`（`https://api.minimax.io/v1`）、`deepseek-flash`（`https://api.deepseek.com/responses`）。Tavily：`https://api.tavily.com/search`。
- 每 run 上限：4 次调用、200,000 token。超时：vision 60 s、search 60 s、reason 120 s、review 120 s。Zod 失败允许 1 次纠错重试。
- 搜索：每条来源正文 ≤ 2,048 字符，最多 6 条。URL 抓取：仅 https、15 s、正文 ≤ 20,480 字节。
- 裁决阈值 `VERDICT_AUTO_THRESHOLD` 默认 `0.8`。
- 密钥只在环境变量；测试全部用假 provider（注入 `fetch`），**任何任务都不得调用真实 API**；真实调用只在 Task 17 spike，且须 Human 授权。
- 提交信息用 Conventional Commits，末尾附 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- 代码风格：常规格式（运算符两侧有空格），每文件一个职责，不引入 `server-only` 之外的 alljobs 依赖。
- 源仓库路径（复制来源）：`~/AgentWorks/GPT_Workspace/alljobs`，下文简写 `$ALLJOBS`。

---

## 文件结构

```
Caphub/
├─ app/
│  ├─ layout.tsx, globals.css, page.tsx          # 投递页（Task 14）
│  └─ api/captures/route.ts                       # POST 投递 / GET 最近（Task 14）
├─ lib/
│  ├─ config.ts                                   # env → 类型化配置（Task 2）
│  ├─ db/{pool.ts, migrate.ts}                    # pg 池、迁移器（Task 3）
│  ├─ db/migrations/001_caphub_v2.sql             # schema（Task 3）
│  ├─ storage/{s3.ts, object-ref.ts}              # 内容寻址对象存储（Task 4）
│  ├─ captures/{captures.ts, dedupe.ts}           # 投递、去重、入队（Task 5）
│  ├─ queue/runs.ts                               # claim/heartbeat/finish（Task 6）
│  ├─ analysis/{card.ts, steps.ts, structured.ts, budget.ts}   # schema、step 记录、结构化调用（Task 7–8）
│  ├─ providers/{minimax.ts, minimax-search.ts, tavily.ts, deepseek.ts, errors.ts}  # Task 9
│  ├─ analysis/material/{image.ts, url.ts, text.ts}            # 素材准备（Task 10）
│  ├─ analysis/pipeline.ts, verdict.ts, capabilities.ts, tags.ts   # 管线、裁决、落库（Task 11）
│  ├─ analysis/review.ts                          # 人工触发复核（Task 13）
│  ├─ retention/retention.ts                      # 清扫（Task 12）
│  └─ auth/access.ts                              # Cloudflare Access JWT（Task 14）
├─ scripts/{worker.ts, migrate.ts, import-v1.ts, spike.ts}
├─ tests/ (与 lib 同构的 *.test.ts 就近放在 lib 内)
├─ railway.json, Dockerfile.web, Dockerfile.worker, .env.example, README.md
```

---

### Task 1: 仓库骨架与工具链

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `eslint.config.mjs`, `.gitignore`, `.env.example`, `README.md`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `lib/version.ts`, `lib/version.test.ts`

**Interfaces:**
- Produces: npm scripts `dev | build | start | test | typecheck | lint | worker | migrate | import:v1 | spike`

- [ ] **Step 1: 建本地仓库与 GitHub 私有 repo**（需 Human 已授权；执行前在会话里再确认一次）

```bash
mkdir -p ~/AgentWorks/CodeSpace/Caphub && cd ~/AgentWorks/CodeSpace/Caphub
git init -b main
gh repo create agentjoey/caphub --private --source=. --remote=origin --description "Personal agent capability library"
```

- [ ] **Step 2: 写 package.json**

```json
{
  "name": "caphub",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start -p ${PORT:-3000} -H 0.0.0.0",
    "lint": "eslint",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "worker": "tsx scripts/worker.ts",
    "migrate": "tsx scripts/migrate.ts",
    "import:v1": "tsx scripts/import-v1.ts",
    "spike": "tsx scripts/spike.ts"
  },
  "dependencies": {
    "@ai-sdk/openai": "^4.0.53",
    "@aws-sdk/client-s3": "^3.1134.0",
    "@tesseract.js-data/chi_sim": "^1.0.0",
    "@tesseract.js-data/eng": "^1.0.0",
    "ai": "^7.0.87",
    "jose": "^6.0.0",
    "next": "16.3.3",
    "pg": "^8.23.0",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "server-only": "^0.0.1",
    "sharp": "^0.35.4",
    "tesseract.js": "^7.0.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@types/pg": "^8.23.1",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "eslint": "^9",
    "eslint-config-next": "16.3.3",
    "tsx": "^4.23.12",
    "typescript": "^5",
    "vitest": "^4.1.10"
  }
}
```

`start` 绑 `0.0.0.0` 是因为 Railway 容器内需要对外监听；对外安全边界由 Task 14 的 Access JWT 校验承担（spec §3.4）。

- [ ] **Step 3: 复制并精简配置文件**

```bash
cp $ALLJOBS/tsconfig.json $ALLJOBS/next.config.ts $ALLJOBS/eslint.config.mjs .
cat > vitest.config.ts <<'EOF'
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["lib/**/*.test.ts", "scripts/**/*.test.ts"], environment: "node" },
  resolve: { alias: { "server-only": new URL("./lib/test/server-only.ts", import.meta.url).pathname } }
});
EOF
mkdir -p lib/test && echo "export {};" > lib/test/server-only.ts
printf 'node_modules\n.next\n.env\n.env.*\n!.env.example\ncoverage\n' > .gitignore
```

- [ ] **Step 4: 写 `.env.example`**（只有名字，没有值）

```
DATABASE_URL=
DATABASE_URL_READONLY=
S3_ENDPOINT=
S3_REGION=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_BUCKET=caphub-objects
MINIMAX_API_KEY=
DEEPSEEK_API_KEY=
TAVILY_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_OWNER_CHAT_ID=
CF_ACCESS_AUD=
CF_ACCESS_TEAM_DOMAIN=
PIPELINE=minimax
VERDICT_AUTO_THRESHOLD=0.8
ANALYSIS_ENABLED=true
RETENTION_ENABLED=true
TELEGRAM_ENABLED=false
```

- [ ] **Step 5: 最小页面与一个冒烟测试**

`app/layout.tsx`:
```tsx
import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "Caphub" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
```
`app/page.tsx`:
```tsx
export default function Page() {
  return <main><h1>Caphub</h1></main>;
}
```
`app/globals.css`：从 `$ALLJOBS/app/globals.css` 复制 `:root` 变量、`body`、`.section-nav` 三段（Paper Workbench 基础色与字体），其余不复制。

`lib/version.ts`:
```ts
export const CAPHUB_VERSION = "2.0.0";
```
`lib/version.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { CAPHUB_VERSION } from "./version";

describe("version", () => {
  it("is v2", () => {
    expect(CAPHUB_VERSION.startsWith("2.")).toBe(true);
  });
});
```

- [ ] **Step 6: 安装并验证**

Run: `npm install && npm test && npm run typecheck && npm run build`
Expected: 1 test passed；typecheck 无错；build 成功。

- [ ] **Step 7: README 与首次提交推送**

`README.md` 写三段：定位一句话（spec §1）、本地运行（`cp .env.example .env`、`npm run migrate`、`npm run dev`、`npm run worker`）、spec 链接（指向 alljobs 仓库路径，Task 18 会把 spec 搬过来）。

```bash
git add -A && git commit -m "chore: bootstrap caphub v2 repository" && git push -u origin main
```

---

### Task 2: 环境变量配置

**Files:**
- Create: `lib/config.ts`, `lib/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: Record<string, string | undefined>): Config`；`type Config = { databaseUrl; s3: {endpoint; region; accessKeyId; secretAccessKey; bucket}; providers: {minimaxApiKey; deepseekApiKey; tavilyApiKey?}; telegram: {enabled; botToken?; ownerChatId?}; access: {aud; teamDomain}; pipeline: "minimax" | "mixed"; verdictAutoThreshold: number; analysisEnabled: boolean; retentionEnabled: boolean }`

- [ ] **Step 1: 失败测试**

`lib/config.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const base = {
  DATABASE_URL: "postgres://u:p@h/db",
  S3_ENDPOINT: "https://s3.example.com", S3_REGION: "ap-southeast-1",
  S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s", S3_BUCKET: "caphub-objects",
  MINIMAX_API_KEY: "m", DEEPSEEK_API_KEY: "d",
  CF_ACCESS_AUD: "aud", CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com"
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c.pipeline).toBe("minimax");
    expect(c.verdictAutoThreshold).toBe(0.8);
    expect(c.analysisEnabled).toBe(true);
    expect(c.telegram.enabled).toBe(false);
  });
  it("requires tavily key when pipeline is mixed", () => {
    expect(() => loadConfig({ ...base, PIPELINE: "mixed" })).toThrow(/TAVILY_API_KEY/);
  });
  it("requires telegram fields when enabled", () => {
    expect(() => loadConfig({ ...base, TELEGRAM_ENABLED: "true" })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
  it("rejects non-https s3 endpoint", () => {
    expect(() => loadConfig({ ...base, S3_ENDPOINT: "http://x" })).toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run lib/config.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`lib/config.ts`:
```ts
import { z } from "zod";

const bool = z.enum(["true", "false"]).default("false").transform((v) => v === "true");
const boolTrue = z.enum(["true", "false"]).default("true").transform((v) => v === "true");

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_READONLY: z.string().optional(),
  S3_ENDPOINT: z.string().url().refine((u) => u.startsWith("https://"), "S3_ENDPOINT must be https"),
  S3_REGION: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().default("caphub-objects"),
  MINIMAX_API_KEY: z.string().min(1),
  DEEPSEEK_API_KEY: z.string().min(1),
  TAVILY_API_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_OWNER_CHAT_ID: z.string().optional(),
  CF_ACCESS_AUD: z.string().min(1),
  CF_ACCESS_TEAM_DOMAIN: z.string().min(1),
  PIPELINE: z.enum(["minimax", "mixed"]).default("minimax"),
  VERDICT_AUTO_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  ANALYSIS_ENABLED: boolTrue,
  RETENTION_ENABLED: boolTrue,
  TELEGRAM_ENABLED: bool
});

export type Pipeline = "minimax" | "mixed";

export interface Config {
  databaseUrl: string;
  databaseUrlReadonly?: string;
  s3: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; bucket: string };
  providers: { minimaxApiKey: string; deepseekApiKey: string; tavilyApiKey?: string };
  telegram: { enabled: boolean; botToken?: string; ownerChatId?: string };
  access: { aud: string; teamDomain: string };
  pipeline: Pipeline;
  verdictAutoThreshold: number;
  analysisEnabled: boolean;
  retentionEnabled: boolean;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): Config {
  const e = envSchema.parse(env);
  if (e.PIPELINE === "mixed" && !e.TAVILY_API_KEY) throw new Error("TAVILY_API_KEY is required when PIPELINE=mixed");
  if (e.TELEGRAM_ENABLED && (!e.TELEGRAM_BOT_TOKEN || !e.TELEGRAM_OWNER_CHAT_ID)) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_CHAT_ID are required when TELEGRAM_ENABLED=true");
  }
  return {
    databaseUrl: e.DATABASE_URL,
    databaseUrlReadonly: e.DATABASE_URL_READONLY,
    s3: { endpoint: e.S3_ENDPOINT, region: e.S3_REGION, accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY, bucket: e.S3_BUCKET },
    providers: { minimaxApiKey: e.MINIMAX_API_KEY, deepseekApiKey: e.DEEPSEEK_API_KEY, tavilyApiKey: e.TAVILY_API_KEY },
    telegram: { enabled: e.TELEGRAM_ENABLED, botToken: e.TELEGRAM_BOT_TOKEN, ownerChatId: e.TELEGRAM_OWNER_CHAT_ID },
    access: { aud: e.CF_ACCESS_AUD, teamDomain: e.CF_ACCESS_TEAM_DOMAIN },
    pipeline: e.PIPELINE,
    verdictAutoThreshold: e.VERDICT_AUTO_THRESHOLD,
    analysisEnabled: e.ANALYSIS_ENABLED,
    retentionEnabled: e.RETENTION_ENABLED
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run lib/config.test.ts`
Expected: 4 passed

- [ ] **Step 5: 提交**

```bash
git add lib/config.ts lib/config.test.ts && git commit -m "feat(config): typed environment configuration"
```

---

### Task 3: 数据库池、迁移器与 `caphub_v2` schema

**Files:**
- Create: `lib/db/pool.ts`, `lib/db/migrate.ts`, `lib/db/migrate.test.ts`, `lib/db/migrations/001_caphub_v2.sql`, `scripts/migrate.ts`

**Interfaces:**
- Produces: `createPool(databaseUrl: string): Pool`；`applyMigrations(pool: Pool, dir?: string): Promise<string[]>`（返回本次应用的文件名）；表定义见 SQL。

- [ ] **Step 1: 写 schema**

`lib/db/migrations/001_caphub_v2.sql`:
```sql
CREATE SCHEMA IF NOT EXISTS caphub_v2;

CREATE TABLE caphub_v2.captures (
  id text PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('web','telegram','import')),
  kind text NOT NULL CHECK (kind IN ('image','text','url')),
  object_key text CHECK (object_key ~ '^sha256/[a-f0-9]{2}/[a-f0-9]{64}$'),
  mime_type text,
  text text,
  url text,
  dedupe_key text NOT NULL UNIQUE CHECK (dedupe_key ~ '^[a-f0-9]{64}$'),
  telegram_chat_id text,
  telegram_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'image') = (object_key IS NOT NULL)),
  CHECK ((kind = 'text') = (text IS NOT NULL)),
  CHECK ((kind = 'url') = (url IS NOT NULL))
);

CREATE TABLE caphub_v2.analysis_runs (
  id text PRIMARY KEY,
  capture_id text NOT NULL REFERENCES caphub_v2.captures(id) ON DELETE CASCADE,
  pipeline text NOT NULL CHECK (pipeline IN ('minimax','mixed')),
  state text NOT NULL CHECK (state IN ('queued','running','done','failed')),
  lease_until timestamptz,
  owner_token text,
  attempts integer NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'running') = (owner_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX analysis_runs_claim ON caphub_v2.analysis_runs(state, lease_until, created_at);
CREATE INDEX analysis_runs_capture ON caphub_v2.analysis_runs(capture_id, created_at DESC);

CREATE TABLE caphub_v2.analysis_steps (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES caphub_v2.analysis_runs(id) ON DELETE CASCADE,
  step text NOT NULL CHECK (step IN ('vision','search','reason','review')),
  provider text NOT NULL,
  model text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  input_tokens integer,
  output_tokens integer,
  duration_ms integer NOT NULL,
  ok boolean NOT NULL,
  error text,
  output jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analysis_steps_run ON caphub_v2.analysis_steps(run_id, id);

CREATE TABLE caphub_v2.capabilities (
  id text PRIMARY KEY,
  capture_id text NOT NULL UNIQUE REFERENCES caphub_v2.captures(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES caphub_v2.analysis_runs(id) ON DELETE RESTRICT,
  title text NOT NULL,
  type text NOT NULL CHECK (type IN ('skill','experience','plugin','prompt','other')),
  summary text NOT NULL,
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggested_verdict text NOT NULL CHECK (suggested_verdict IN ('keep','discard')),
  suggested_reason text NOT NULL,
  confidence real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  verdict text NOT NULL CHECK (verdict IN ('keep','discard','pending')),
  verdict_by text CHECK (verdict_by IN ('auto','human')),
  verdict_at timestamptz,
  usage text NOT NULL CHECK (usage IN ('integrate','reference')),
  playbook jsonb NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  source_url text,
  review_note jsonb,
  notified_at timestamptz,
  synced_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || array_to_string(tags,' ') || ' ' || coalesce(playbook::text,''))
  ) STORED
);
CREATE INDEX capabilities_verdict ON caphub_v2.capabilities(verdict, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX capabilities_search ON caphub_v2.capabilities USING gin(search);
CREATE INDEX capabilities_tags ON caphub_v2.capabilities USING gin(tags);

CREATE TABLE caphub_v2.tags (
  name text PRIMARY KEY,
  use_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE caphub_v2.retention (
  object_key text PRIMARY KEY,
  eligible_at timestamptz NOT NULL,
  purged_at timestamptz,
  error_code text
);
CREATE INDEX retention_due ON caphub_v2.retention(eligible_at) WHERE purged_at IS NULL;

CREATE TABLE caphub_v2.schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: 失败测试（用 pg-mem 不可行——直接用注入的假 `query`）**

`lib/db/migrate.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { planMigrations } from "./migrate";

describe("planMigrations", () => {
  it("returns only files not yet applied, sorted", () => {
    const plan = planMigrations(["002_b.sql", "001_a.sql", "003_c.sql"], new Set(["001_a.sql"]));
    expect(plan).toEqual(["002_b.sql", "003_c.sql"]);
  });
  it("rejects files without numeric prefix", () => {
    expect(() => planMigrations(["x.sql"], new Set())).toThrow(/migration name/);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run lib/db/migrate.test.ts` → FAIL

- [ ] **Step 4: 实现池与迁移器**

`lib/db/pool.ts`:
```ts
import { Pool } from "pg";

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 4, ssl: { rejectUnauthorized: true } });
}
```

`lib/db/migrate.ts`:
```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

const DEFAULT_DIR = new URL("./migrations/", import.meta.url).pathname;

export function planMigrations(files: readonly string[], applied: ReadonlySet<string>): string[] {
  for (const f of files) if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(f)) throw new Error(`invalid migration name: ${f}`);
  return [...files].sort().filter((f) => !applied.has(f));
}

export async function applyMigrations(pool: Pool, dir: string = DEFAULT_DIR): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('caphub_v2.migrate'), 0)");
    await client.query("CREATE SCHEMA IF NOT EXISTS caphub_v2");
    await client.query("CREATE TABLE IF NOT EXISTS caphub_v2.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const applied = new Set((await client.query<{ name: string }>("SELECT name FROM caphub_v2.schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql"));
    const plan = planMigrations(files, applied);
    for (const name of plan) {
      await client.query(await readFile(join(dir, name), "utf8"));
      await client.query("INSERT INTO caphub_v2.schema_migrations (name) VALUES ($1)", [name]);
    }
    await client.query("COMMIT");
    return plan;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

`scripts/migrate.ts`:
```ts
import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { applyMigrations } from "../lib/db/migrate";

const pool = createPool(loadConfig().databaseUrl);
applyMigrations(pool)
  .then((applied) => { console.log(JSON.stringify({ applied })); return pool.end(); })
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; return pool.end(); });
```

注意 001 里的 `CREATE TABLE caphub_v2.schema_migrations` 会与迁移器的 `IF NOT EXISTS` 重复——把 SQL 文件里那段改为 `CREATE TABLE IF NOT EXISTS`。

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run lib/db/migrate.test.ts` → 2 passed

- [ ] **Step 6: 在临时 Neon branch 上真实应用一次**（需 Human 授权 Neon 建 branch；不动主 branch）

```bash
# 用 Neon MCP create_branch(project lingering-term-10256714, name "v2-migrate-test") 拿到连接串后：
DATABASE_URL='<branch url>' npm run migrate
# 期望输出 {"applied":["001_caphub_v2.sql"]}；再跑一次期望 {"applied":[]}
# 完成后用 Neon MCP delete_branch 删除该 branch
```

- [ ] **Step 7: 提交**

```bash
git add lib/db scripts/migrate.ts && git commit -m "feat(db): caphub_v2 schema and forward-only migrator"
```

---

### Task 4: 内容寻址对象存储（S3）

**Files:**
- Create: `lib/storage/object-ref.ts`, `lib/storage/object-ref.test.ts`, `lib/storage/s3.ts`, `lib/storage/s3.test.ts`
- 来源：`$ALLJOBS/lib/caphub/storage/neon-s3.ts`（精简：去掉 `managedEndpointHosts` 白名单、`ImmutableObjectMismatchError` 继承与 `local-objects` 依赖）

**Interfaces:**
- Produces: `objectRefFor(bytes: Uint8Array): ObjectRef`（`{ key: string; digest: string; bytes: number }`）；`class ObjectStore { putIfAbsent(bytes, mimeType): Promise<ObjectRef>; get(ref): Promise<Uint8Array>; deleteExact(key): Promise<void> }`；`createObjectStore(config: Config["s3"], client?: S3Client): ObjectStore`

- [ ] **Step 1: 失败测试**

`lib/storage/object-ref.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { objectRefFor } from "./object-ref";

describe("objectRefFor", () => {
  it("derives sha256 key like v1", () => {
    const ref = objectRefFor(new TextEncoder().encode("hello"));
    expect(ref.digest).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(ref.key).toBe(`sha256/2c/${ref.digest}`);
    expect(ref.bytes).toBe(5);
  });
  it("rejects empty input", () => {
    expect(() => objectRefFor(new Uint8Array())).toThrow();
  });
});
```

`lib/storage/s3.test.ts`（假 S3 client：记录命令）:
```ts
import { describe, expect, it } from "vitest";
import { HeadObjectCommand, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { ObjectStore } from "./s3";

function fakeClient(store: Map<string, Uint8Array>) {
  return {
    async send(cmd: unknown) {
      if (cmd instanceof HeadObjectCommand) {
        const b = store.get(cmd.input.Key!);
        if (!b) throw Object.assign(new Error("nf"), { $metadata: { httpStatusCode: 404 } });
        return { ContentLength: b.byteLength, Metadata: { "caphub-sha256": cmd.input.Key!.split("/")[2] } };
      }
      if (cmd instanceof PutObjectCommand) { store.set(cmd.input.Key!, cmd.input.Body as Uint8Array); return {}; }
      if (cmd instanceof GetObjectCommand) {
        const b = store.get(cmd.input.Key!)!;
        return { Body: { transformToByteArray: async () => b } };
      }
      throw new Error("unexpected");
    }
  };
}

describe("ObjectStore", () => {
  it("puts once and returns same ref on repeat", async () => {
    const backing = new Map<string, Uint8Array>();
    const store = new ObjectStore({ bucket: "b", client: fakeClient(backing) as never });
    const bytes = new TextEncoder().encode("img");
    const a = await store.putIfAbsent(bytes, "image/png");
    const b = await store.putIfAbsent(bytes, "image/png");
    expect(a).toEqual(b);
    expect(backing.size).toBe(1);
    expect(await store.get(a)).toEqual(bytes);
  });
});
```

- [ ] **Step 2: 运行确认失败** → `npx vitest run lib/storage` FAIL

- [ ] **Step 3: 实现**

`lib/storage/object-ref.ts`:
```ts
import { createHash } from "node:crypto";
import { z } from "zod";

export const objectRefSchema = z.object({
  key: z.string().regex(/^sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive()
});
export type ObjectRef = z.infer<typeof objectRefSchema>;

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function objectRefFor(bytes: Uint8Array): ObjectRef {
  if (bytes.byteLength === 0) throw new TypeError("object bytes must be non-empty");
  const digest = sha256Hex(bytes);
  return { key: `sha256/${digest.slice(0, 2)}/${digest}`, digest, bytes: bytes.byteLength };
}
```

`lib/storage/s3.ts`:
```ts
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Config } from "../config";
import { objectRefFor, objectRefSchema, sha256Hex, type ObjectRef } from "./object-ref";

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export class ObjectMismatchError extends Error {
  constructor() { super("stored object does not match its content address"); this.name = "ObjectMismatchError"; }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
}

export class ObjectStore {
  private readonly bucket: string;
  private readonly client: Pick<S3Client, "send">;

  constructor(options: { bucket: string; client: Pick<S3Client, "send"> }) {
    this.bucket = options.bucket;
    this.client = options.client;
  }

  private async head(key: string): Promise<{ bytes: number; digest: string | undefined } | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { bytes: out.ContentLength ?? -1, digest: out.Metadata?.["caphub-sha256"] };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async putIfAbsent(bytes: Uint8Array, mimeType: ImageMime): Promise<ObjectRef> {
    const ref = objectRefFor(bytes);
    const existing = await this.head(ref.key);
    if (existing) {
      if (existing.bytes !== ref.bytes || existing.digest !== ref.digest) throw new ObjectMismatchError();
      return ref;
    }
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: ref.key, Body: bytes, ContentType: mimeType,
      ContentLength: ref.bytes, Metadata: { "caphub-sha256": ref.digest }, IfNoneMatch: "*"
    }));
    return ref;
  }

  async get(rawRef: ObjectRef): Promise<Uint8Array> {
    const ref = objectRefSchema.parse(rawRef);
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: ref.key }));
    const bytes = await out.Body!.transformToByteArray();
    if (bytes.byteLength !== ref.bytes || sha256Hex(bytes) !== ref.digest) throw new ObjectMismatchError();
    return bytes;
  }

  async deleteExact(key: string): Promise<void> {
    if (!/^sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(key)) throw new Error("INVALID_OBJECT_KEY");
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function createObjectStore(s3: Config["s3"]): ObjectStore {
  const client = new S3Client({
    endpoint: s3.endpoint, region: s3.region, forcePathStyle: true,
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey }
  });
  return new ObjectStore({ bucket: s3.bucket, client });
}
```

- [ ] **Step 4: 运行确认通过** → `npx vitest run lib/storage` 3 passed

- [ ] **Step 5: 提交**

```bash
git add lib/storage && git commit -m "feat(storage): content-addressed S3 object store"
```

---

### Task 5: 投递、去重、入队

**Files:**
- Create: `lib/captures/captures.ts`, `lib/captures/captures.test.ts`, `lib/captures/dedupe.ts`, `lib/captures/dedupe.test.ts`, `lib/ids.ts`

**Interfaces:**
- Consumes: `ObjectStore` (Task 4)、`Pool` (Task 3)
- Produces:
  - `newId(prefix: "cap" | "run" | "cab"): string`（`cap_` + 16 hex）
  - `dedupeKeyFor(input: CaptureInput): string`
  - `type CaptureInput = { source: "web" | "telegram" | "import"; telegram?: { chatId: string; messageId: string } } & ({ kind: "image"; bytes: Uint8Array; mimeType: ImageMime } | { kind: "text"; text: string } | { kind: "url"; url: string })`
  - `submitCapture(deps: { pool: Pool; objects: ObjectStore; pipeline: Pipeline }, input: CaptureInput): Promise<{ captureId: string; runId: string | null; duplicate: boolean }>`
  - `listRecentCaptures(pool: Pool, limit?: number): Promise<RecentCapture[]>`（`{ id; kind; createdAt; runState: "queued"|"running"|"done"|"failed"|null; capabilityId: string|null; errorCode: string|null }`）

- [ ] **Step 1: 失败测试**

`lib/captures/dedupe.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { dedupeKeyFor } from "./dedupe";

describe("dedupeKeyFor", () => {
  it("is content sha256 for images", () => {
    const k = dedupeKeyFor({ source: "web", kind: "image", bytes: new TextEncoder().encode("x"), mimeType: "image/png" });
    expect(k).toBe("2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
  });
  it("normalizes text whitespace and url trailing slash", () => {
    const a = dedupeKeyFor({ source: "web", kind: "text", text: "  hello   world \n" });
    const b = dedupeKeyFor({ source: "web", kind: "text", text: "hello world" });
    expect(a).toBe(b);
    expect(dedupeKeyFor({ source: "web", kind: "url", url: "https://a.b/c/" })).toBe(dedupeKeyFor({ source: "web", kind: "url", url: "https://a.b/c" }));
  });
  it("rejects non-https url", () => {
    expect(() => dedupeKeyFor({ source: "web", kind: "url", url: "http://a.b" })).toThrow(/https/);
  });
});
```

`lib/captures/captures.test.ts`（假 pool：按 SQL 前缀分派）:
```ts
import { describe, expect, it } from "vitest";
import { submitCapture } from "./captures";

function fakePool(existing: { id: string } | null) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      if (text.startsWith("SELECT id FROM caphub_v2.captures")) return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  return { queries, pool: { connect: async () => client } as never };
}

const objects = { putIfAbsent: async () => ({ key: "sha256/ab/" + "a".repeat(64), digest: "a".repeat(64), bytes: 1 }) } as never;

describe("submitCapture", () => {
  it("inserts capture and queued run for new text", async () => {
    const { pool, queries } = fakePool(null);
    const out = await submitCapture({ pool, objects, pipeline: "minimax" }, { source: "web", kind: "text", text: "hi" });
    expect(out.duplicate).toBe(false);
    expect(out.runId).toMatch(/^run_/);
    expect(queries.some((q) => q.text.startsWith("INSERT INTO caphub_v2.captures"))).toBe(true);
    expect(queries.some((q) => q.text.startsWith("INSERT INTO caphub_v2.analysis_runs"))).toBe(true);
  });
  it("returns existing capture on duplicate without enqueuing", async () => {
    const { pool, queries } = fakePool({ id: "cap_existing" });
    const out = await submitCapture({ pool, objects, pipeline: "minimax" }, { source: "web", kind: "text", text: "hi" });
    expect(out).toEqual({ captureId: "cap_existing", runId: null, duplicate: true });
    expect(queries.some((q) => q.text.startsWith("INSERT INTO caphub_v2.analysis_runs"))).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败** → `npx vitest run lib/captures` FAIL

- [ ] **Step 3: 实现**

`lib/ids.ts`:
```ts
import { randomBytes } from "node:crypto";
export function newId(prefix: "cap" | "run" | "cab"): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}
```

`lib/captures/dedupe.ts`:
```ts
import { sha256Hex } from "../storage/object-ref";
import type { ImageMime } from "../storage/s3";

export type CaptureInput = {
  source: "web" | "telegram" | "import";
  telegram?: { chatId: string; messageId: string };
} & (
  | { kind: "image"; bytes: Uint8Array; mimeType: ImageMime }
  | { kind: "text"; text: string }
  | { kind: "url"; url: string }
);

export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("url must use https");
  parsed.hash = "";
  const s = parsed.toString();
  return s.endsWith("/") && parsed.pathname !== "/" ? s.slice(0, -1) : s;
}

export function dedupeKeyFor(input: CaptureInput): string {
  switch (input.kind) {
    case "image": return sha256Hex(input.bytes);
    case "text": return sha256Hex(`text\0${normalizeText(input.text)}`);
    case "url": return sha256Hex(`url\0${normalizeUrl(input.url)}`);
  }
}
```

`lib/captures/captures.ts`:
```ts
import type { Pool } from "pg";
import type { Pipeline } from "../config";
import { newId } from "../ids";
import type { ObjectStore } from "../storage/s3";
import { dedupeKeyFor, normalizeText, normalizeUrl, type CaptureInput } from "./dedupe";

export interface SubmitResult { captureId: string; runId: string | null; duplicate: boolean }

export async function submitCapture(
  deps: { pool: Pool; objects: ObjectStore; pipeline: Pipeline },
  input: CaptureInput
): Promise<SubmitResult> {
  const dedupeKey = dedupeKeyFor(input);
  const objectRef = input.kind === "image" ? await deps.objects.putIfAbsent(input.bytes, input.mimeType) : null;
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('caphub_v2.capture'), hashtext($1))", [dedupeKey]);
    const existing = await client.query<{ id: string }>("SELECT id FROM caphub_v2.captures WHERE dedupe_key = $1", [dedupeKey]);
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return { captureId: existing.rows[0].id, runId: null, duplicate: true };
    }
    const captureId = newId("cap");
    await client.query(
      `INSERT INTO caphub_v2.captures (id, source, kind, object_key, mime_type, text, url, dedupe_key, telegram_chat_id, telegram_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [captureId, input.source, input.kind, objectRef?.key ?? null,
        input.kind === "image" ? input.mimeType : null,
        input.kind === "text" ? normalizeText(input.text) : null,
        input.kind === "url" ? normalizeUrl(input.url) : null,
        dedupeKey, input.telegram?.chatId ?? null, input.telegram?.messageId ?? null]
    );
    if (objectRef) {
      await client.query(
        "INSERT INTO caphub_v2.retention (object_key, eligible_at) VALUES ($1, now() + interval '30 days') ON CONFLICT DO NOTHING",
        [objectRef.key]
      );
    }
    const runId = newId("run");
    await client.query(
      "INSERT INTO caphub_v2.analysis_runs (id, capture_id, pipeline, state) VALUES ($1, $2, $3, 'queued')",
      [runId, captureId, deps.pipeline]
    );
    await client.query("COMMIT");
    return { captureId, runId, duplicate: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface RecentCapture {
  id: string; kind: "image" | "text" | "url"; createdAt: string;
  runState: "queued" | "running" | "done" | "failed" | null;
  capabilityId: string | null; errorCode: string | null;
}

export async function listRecentCaptures(pool: Pool, limit = 20): Promise<RecentCapture[]> {
  const { rows } = await pool.query<RecentCapture>(
    `SELECT c.id, c.kind, c.created_at AS "createdAt", r.state AS "runState", cb.id AS "capabilityId", r.error_code AS "errorCode"
     FROM caphub_v2.captures c
     LEFT JOIN LATERAL (SELECT state, error_code FROM caphub_v2.analysis_runs WHERE capture_id = c.id ORDER BY created_at DESC LIMIT 1) r ON true
     LEFT JOIN caphub_v2.capabilities cb ON cb.capture_id = c.id
     ORDER BY c.created_at DESC LIMIT $1`, [limit]);
  return rows;
}
```

- [ ] **Step 4: 运行确认通过** → `npx vitest run lib/captures` 5 passed

- [ ] **Step 5: 提交**

```bash
git add lib/ids.ts lib/captures && git commit -m "feat(captures): submit, dedupe and enqueue captures"
```

---

### Task 6: 队列（claim / heartbeat / finish）

**Files:**
- Create: `lib/queue/runs.ts`, `lib/queue/runs.test.ts`
- 来源：`$ALLJOBS/lib/caphub/registry/postgres/analysis-requests.ts`（改表名、改主键为 `id`、去掉 v1 的 `ensure`）

**Interfaces:**
- Produces: `class RunQueue { constructor(pool: Pool); claim(ownerToken: string, now: Date): Promise<Lease | null>; heartbeat(lease, now): Promise<boolean>; finish(lease, outcome: { state: "done" | "failed"; errorCode?: string; errorMessage?: string }, now): Promise<boolean>; requeue(runId: string): Promise<void>; summary(): Promise<Array<{ state: string; count: number }>> }`；`type Lease = { runId: string; captureId: string; pipeline: Pipeline; ownerToken: string }`
- 租约 120 s，心跳 30 s 由 worker 负责（Task 12）。全局并发 1（与 v1 相同）。

- [ ] **Step 1: 失败测试**（断言 SQL 语义，用记录型假 pool）

`lib/queue/runs.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { RunQueue } from "./runs";

function fakePool(claimRow: Record<string, unknown> | undefined) {
  const calls: string[] = [];
  const client = {
    async query(text: string) {
      calls.push(text);
      if (text.includes("UPDATE caphub_v2.analysis_runs r SET state = 'running'")) return { rows: claimRow ? [claimRow] : [], rowCount: claimRow ? 1 : 0 };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  return { calls, pool: { connect: async () => client, query: client.query } as never };
}

describe("RunQueue.claim", () => {
  it("returns lease when a queued run exists", async () => {
    const { pool } = fakePool({ id: "run_1", capture_id: "cap_1", pipeline: "minimax" });
    const lease = await new RunQueue(pool).claim("tok", new Date("2026-09-19T00:00:00Z"));
    expect(lease).toEqual({ runId: "run_1", captureId: "cap_1", pipeline: "minimax", ownerToken: "tok" });
  });
  it("returns null when nothing claimable and takes the worker advisory lock", async () => {
    const { pool, calls } = fakePool(undefined);
    expect(await new RunQueue(pool).claim("tok", new Date())).toBeNull();
    expect(calls.some((c) => c.includes("pg_advisory_xact_lock(hashtext('caphub_v2.worker')"))).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 实现**

`lib/queue/runs.ts`:
```ts
import type { Pool } from "pg";
import type { Pipeline } from "../config";

export interface Lease { runId: string; captureId: string; pipeline: Pipeline; ownerToken: string }
export interface RunOutcome { state: "done" | "failed"; errorCode?: string; errorMessage?: string }

const LEASE = "interval '120 seconds'";

export class RunQueue {
  constructor(private readonly pool: Pool) {}

  async claim(ownerToken: string, now: Date): Promise<Lease | null> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtext('caphub_v2.worker'), 0)");
      const row = await db.query<{ id: string; capture_id: string; pipeline: Pipeline }>(
        `WITH next AS (
           SELECT id FROM caphub_v2.analysis_runs
           WHERE (state = 'queued' OR (state = 'running' AND lease_until <= $1))
             AND NOT EXISTS (SELECT 1 FROM caphub_v2.analysis_runs WHERE state = 'running' AND lease_until > $1)
           ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE caphub_v2.analysis_runs r SET state = 'running', owner_token = $2,
           lease_until = $1::timestamptz + ${LEASE}, attempts = r.attempts + 1,
           started_at = coalesce(r.started_at, $1)
         FROM next WHERE r.id = next.id RETURNING r.id, r.capture_id, r.pipeline`,
        [now.toISOString(), ownerToken]
      );
      await db.query("COMMIT");
      const r = row.rows[0];
      return r ? { runId: r.id, captureId: r.capture_id, pipeline: r.pipeline, ownerToken } : null;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }

  async heartbeat(lease: Lease, now: Date): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE caphub_v2.analysis_runs SET lease_until = $2::timestamptz + ${LEASE}
       WHERE id = $1 AND owner_token = $3 AND state = 'running' AND lease_until > $2`,
      [lease.runId, now.toISOString(), lease.ownerToken]);
    return r.rowCount === 1;
  }

  async finish(lease: Lease, outcome: RunOutcome, now: Date): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE caphub_v2.analysis_runs SET state = $4, owner_token = NULL, lease_until = NULL,
         error_code = $5, error_message = $6, finished_at = $2
       WHERE id = $1 AND owner_token = $3 AND state = 'running' AND lease_until > $2`,
      [lease.runId, now.toISOString(), lease.ownerToken, outcome.state, outcome.errorCode ?? null, outcome.errorMessage ?? null]);
    return r.rowCount === 1;
  }

  async requeue(runId: string): Promise<void> {
    await this.pool.query(
      "UPDATE caphub_v2.analysis_runs SET state = 'queued', owner_token = NULL, lease_until = NULL, error_code = NULL, error_message = NULL, finished_at = NULL WHERE id = $1 AND state = 'failed'",
      [runId]);
  }

  async summary(): Promise<Array<{ state: string; count: number }>> {
    const r = await this.pool.query<{ state: string; count: string }>("SELECT state, count(*)::text AS count FROM caphub_v2.analysis_runs GROUP BY state ORDER BY state");
    return r.rows.map((x) => ({ state: x.state, count: Number(x.count) }));
  }
}
```

- [ ] **Step 4: 运行确认通过** → 2 passed

- [ ] **Step 5: 提交**

```bash
git add lib/queue && git commit -m "feat(queue): lease-based analysis run queue"
```

---

### Task 7: Step 记录、预算与结构化调用

**Files:**
- Create: `lib/analysis/budget.ts`, `lib/analysis/steps.ts`, `lib/analysis/structured.ts`, `lib/analysis/structured.test.ts`, `lib/providers/errors.ts`
- 来源思路：`$ALLJOBS/lib/caphub/providers/structured-stage.ts`（去掉 audit store / workflow contracts，换成写 `analysis_steps`）

**Interfaces:**
- Produces:
  - `class ProviderError extends Error { code: "TIMEOUT" | "AUTHENTICATION" | "BILLING" | "UNAVAILABLE" | "INVALID_OUTPUT" | "ABORTED" }`
  - `class RunBudget { calls = 0; tokens = 0; constructor(limits = { maxCalls: 4, maxTokens: 200_000 }); charge(tokens): void /* throws ProviderError("BUDGET") */ ; assertCanCall(): void }`
  - `type StepName = "vision" | "search" | "reason" | "review"`
  - `recordStep(pool, row: { runId; step; provider; model; attempt; inputTokens?; outputTokens?; durationMs; ok; error?; output? }): Promise<void>`
  - `type StructuredCall = { provider: string; model: string; invoke(input: { prompt: string; images?: Array<{ data: Uint8Array; mediaType: string }>; schemaName: string; schema: z.ZodType; correction?: { issues: string[] } }, signal: AbortSignal): Promise<{ value: unknown; usage: { inputTokens: number; outputTokens: number } }> }`
  - `runStructured<T>(req: { pool; runId; step: StepName; call: StructuredCall; prompt: string; images?; schemaName; schema: z.ZodType<T>; budget: RunBudget; timeoutMs: number; signal: AbortSignal }): Promise<T>`（一次纠错重试；每次尝试写一行 step；失败抛 `ProviderError`）

- [ ] **Step 1: 失败测试**

`lib/analysis/structured.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runStructured } from "./structured";
import { RunBudget } from "./budget";
import { ProviderError } from "../providers/errors";

function recorder() {
  const rows: Array<Record<string, unknown>> = [];
  return { rows, pool: { query: async (_t: string, v: unknown[]) => { rows.push({ step: v[1], attempt: v[4], ok: v[8] }); return { rows: [] }; } } as never };
}
const schema = z.object({ n: z.number() });
const base = (call: unknown, pool: unknown) => ({
  pool, runId: "run_1", step: "reason" as const, call: call as never, prompt: "p", schemaName: "t", schema,
  budget: new RunBudget(), timeoutMs: 1000, signal: new AbortController().signal
});

describe("runStructured", () => {
  it("returns parsed value and records one ok step", async () => {
    const { rows, pool } = recorder();
    const call = { provider: "x", model: "m", invoke: async () => ({ value: { n: 1 }, usage: { inputTokens: 1, outputTokens: 1 } }) };
    expect(await runStructured(base(call, pool))).toEqual({ n: 1 });
    expect(rows).toEqual([{ step: "reason", attempt: 1, ok: true }]);
  });
  it("retries once with correction on schema failure, then throws", async () => {
    const { rows, pool } = recorder();
    const seen: unknown[] = [];
    const call = { provider: "x", model: "m", invoke: async (i: { correction?: unknown }) => { seen.push(i.correction); return { value: { n: "bad" }, usage: { inputTokens: 1, outputTokens: 1 } }; } };
    await expect(runStructured(base(call, pool))).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toMatchObject({ issues: [expect.stringContaining("n")] });
    expect(rows.map((r) => r.ok)).toEqual([false, false]);
  });
  it("times out", async () => {
    const { pool } = recorder();
    const call = { provider: "x", model: "m", invoke: (_i: unknown, s: AbortSignal) => new Promise((_r, rej) => s.addEventListener("abort", () => rej(new ProviderError("ABORTED")))) };
    await expect(runStructured({ ...base(call, pool), timeoutMs: 10 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("enforces call budget", async () => {
    const { pool } = recorder();
    const budget = new RunBudget({ maxCalls: 0, maxTokens: 10 });
    const call = { provider: "x", model: "m", invoke: async () => ({ value: { n: 1 }, usage: { inputTokens: 1, outputTokens: 1 } }) };
    await expect(runStructured({ ...base(call, pool), budget })).rejects.toMatchObject({ code: "BUDGET" });
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 实现**

`lib/providers/errors.ts`:
```ts
export type ProviderErrorCode = "TIMEOUT" | "AUTHENTICATION" | "BILLING" | "UNAVAILABLE" | "INVALID_OUTPUT" | "ABORTED" | "BUDGET";

export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, options?: ErrorOptions) {
    super(`provider call failed: ${code}`, options);
    this.name = "ProviderError";
  }
}

export function failureForHttpStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "AUTHENTICATION";
  if (status === 402 || status === 429) return "BILLING";
  if (status === 400 || status === 422) return "INVALID_OUTPUT";
  return "UNAVAILABLE";
}
```

`lib/analysis/budget.ts`:
```ts
import { ProviderError } from "../providers/errors";

export class RunBudget {
  calls = 0;
  tokens = 0;
  constructor(readonly limits: { maxCalls: number; maxTokens: number } = { maxCalls: 4, maxTokens: 200_000 }) {}
  assertCanCall(): void {
    if (this.calls >= this.limits.maxCalls) throw new ProviderError("BUDGET");
  }
  charge(tokens: number): void {
    this.tokens += tokens;
    if (this.tokens > this.limits.maxTokens) throw new ProviderError("BUDGET");
  }
}
```

`lib/analysis/steps.ts`:
```ts
import type { Pool } from "pg";

export type StepName = "vision" | "search" | "reason" | "review";

export interface StepRow {
  runId: string; step: StepName; provider: string; model: string; attempt: number;
  inputTokens?: number; outputTokens?: number; durationMs: number; ok: boolean; error?: string; output?: unknown;
}

export async function recordStep(pool: Pick<Pool, "query">, row: StepRow): Promise<void> {
  await pool.query(
    `INSERT INTO caphub_v2.analysis_steps (run_id, step, provider, model, attempt, input_tokens, output_tokens, duration_ms, ok, error, output)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [row.runId, row.step, row.provider, row.model, row.attempt, row.inputTokens ?? null, row.outputTokens ?? null,
      row.durationMs, row.ok, row.error ?? null, row.output === undefined ? null : JSON.stringify(row.output)]);
}
```

`lib/analysis/structured.ts`:
```ts
import type { Pool } from "pg";
import type { z } from "zod";
import { ProviderError } from "../providers/errors";
import type { RunBudget } from "./budget";
import { recordStep, type StepName } from "./steps";

export interface StructuredInput {
  prompt: string;
  images?: Array<{ data: Uint8Array; mediaType: string }>;
  schemaName: string;
  schema: z.ZodType;
  correction?: { issues: string[] };
}

export interface StructuredCall {
  provider: string;
  model: string;
  invoke(input: StructuredInput, signal: AbortSignal): Promise<{ value: unknown; usage: { inputTokens: number; outputTokens: number } }>;
}

export interface RunStructuredRequest<T> {
  pool: Pick<Pool, "query">; runId: string; step: StepName; call: StructuredCall;
  prompt: string; images?: StructuredInput["images"]; schemaName: string; schema: z.ZodType<T>;
  budget: RunBudget; timeoutMs: number; signal: AbortSignal;
}

function withTimeout(signal: AbortSignal, ms: number): { signal: AbortSignal; clear(): void; timedOut(): boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) controller.abort();
  return { signal: controller.signal, clear: () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }, timedOut: () => timedOut };
}

export async function runStructured<T>(req: RunStructuredRequest<T>): Promise<T> {
  let issues: string[] | undefined;
  for (const attempt of [1, 2] as const) {
    req.budget.assertCanCall();
    req.budget.calls += 1;
    const t = withTimeout(req.signal, req.timeoutMs);
    const started = Date.now();
    const base = { runId: req.runId, step: req.step, provider: req.call.provider, model: req.call.model, attempt };
    let raw: Awaited<ReturnType<StructuredCall["invoke"]>>;
    try {
      raw = await req.call.invoke({ prompt: req.prompt, images: req.images, schemaName: req.schemaName, schema: req.schema, ...(issues ? { correction: { issues } } : {}) }, t.signal);
    } catch (error) {
      const code = t.timedOut() ? "TIMEOUT" : error instanceof ProviderError ? error.code : "UNAVAILABLE";
      await recordStep(req.pool, { ...base, durationMs: Date.now() - started, ok: false, error: code });
      throw new ProviderError(code, { cause: error });
    } finally {
      t.clear();
    }
    const durationMs = Date.now() - started;
    req.budget.charge(raw.usage.inputTokens + raw.usage.outputTokens);
    const parsed = req.schema.safeParse(raw.value);
    if (parsed.success) {
      await recordStep(req.pool, { ...base, inputTokens: raw.usage.inputTokens, outputTokens: raw.usage.outputTokens, durationMs, ok: true, output: parsed.data });
      return parsed.data;
    }
    issues = parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`);
    await recordStep(req.pool, { ...base, inputTokens: raw.usage.inputTokens, outputTokens: raw.usage.outputTokens, durationMs, ok: false, error: "INVALID_OUTPUT", output: raw.value });
  }
  throw new ProviderError("INVALID_OUTPUT");
}
```

- [ ] **Step 4: 运行确认通过** → 4 passed

- [ ] **Step 5: 提交**

```bash
git add lib/analysis lib/providers/errors.ts && git commit -m "feat(analysis): structured provider call with step recording and budget"
```

---

### Task 8: CapabilityCard 与 Extraction schema

**Files:**
- Create: `lib/analysis/card.ts`, `lib/analysis/card.test.ts`

**Interfaces:**
- Produces:
  - `capabilityTypeSchema = z.enum(["skill","experience","plugin","prompt","other"])`
  - `extractionSchema`（vision 输出）：`{ what: string; visible_text: string; commands: string[]; prompt_text: string | null; source_hints: string[]; questions: string[] }`
  - `searchResultSchema`：`{ sources: Array<{ title: string; url: string; content: string }> }`（content ≤ 2048）
  - `playbookSchema`：`{ kind: "integrate"; install: string[]; repo: string | null; prompt_text: string | null } | { kind: "reference"; points: string[] } | { kind: "experience"; content: string; when_to_use: string }`
  - `cardSchema`（reason 输出）：`{ title: string(≤60); type; summary: string(≤800); signals: string[](2–3); suggested_verdict: "keep"|"discard"; suggested_reason: string; confidence: number(0–1); usage: "integrate"|"reference"; playbook; tags: string[](1–6, 小写); source_url: string | null }`
  - `reviewNoteSchema`：`{ agrees: boolean; points: string[] }`
  - `type Card = z.infer<typeof cardSchema>` 等

- [ ] **Step 1: 失败测试**

`lib/analysis/card.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { cardSchema } from "./card";

const valid = {
  title: "用 Playwright 生成 axe 可访问性报告", type: "skill", summary: "一段摘要",
  signals: ["解决 CI 里可访问性回归", "与库里已有 e2e-a11y 重叠"],
  suggested_verdict: "keep", suggested_reason: "有可执行命令", confidence: 0.9,
  usage: "integrate", playbook: { kind: "integrate", install: ["npm i -D @axe-core/playwright"], repo: null, prompt_text: null },
  tags: ["testing", "accessibility"], source_url: null
};

describe("cardSchema", () => {
  it("accepts a valid card", () => { expect(cardSchema.parse(valid)).toEqual(valid); });
  it("lowercases tags and rejects >6", () => {
    expect(cardSchema.parse({ ...valid, tags: ["Testing"] }).tags).toEqual(["testing"]);
    expect(() => cardSchema.parse({ ...valid, tags: ["a","b","c","d","e","f","g"] })).toThrow();
  });
  it("requires experience playbook for experience type", () => {
    expect(() => cardSchema.parse({ ...valid, type: "experience" })).toThrow(/experience/);
  });
  it("requires 2-3 signals", () => {
    expect(() => cardSchema.parse({ ...valid, signals: ["one"] })).toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 实现**

`lib/analysis/card.ts`:
```ts
import { z } from "zod";

export const capabilityTypeSchema = z.enum(["skill", "experience", "plugin", "prompt", "other"]);
export type CapabilityType = z.infer<typeof capabilityTypeSchema>;

export const extractionSchema = z.object({
  what: z.string().min(1).max(400),
  visible_text: z.string().max(8000),
  commands: z.array(z.string().max(500)).max(20),
  prompt_text: z.string().max(8000).nullable(),
  source_hints: z.array(z.string().max(200)).max(10),
  questions: z.array(z.string().max(200)).max(5)
});
export type Extraction = z.infer<typeof extractionSchema>;

export const MAX_SOURCE_CONTENT = 2048;
export const MAX_SOURCES = 6;
export const searchResultSchema = z.object({
  sources: z.array(z.object({
    title: z.string().max(300),
    url: z.string().url(),
    content: z.string().max(MAX_SOURCE_CONTENT)
  })).max(MAX_SOURCES)
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const playbookSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("integrate"), install: z.array(z.string().max(500)).max(10), repo: z.string().url().nullable(), prompt_text: z.string().max(8000).nullable() }),
  z.object({ kind: z.literal("reference"), points: z.array(z.string().max(300)).min(1).max(10) }),
  z.object({ kind: z.literal("experience"), content: z.string().min(1).max(8000), when_to_use: z.string().max(300) })
]);
export type Playbook = z.infer<typeof playbookSchema>;

export const cardSchema = z.object({
  title: z.string().min(1).max(60),
  type: capabilityTypeSchema,
  summary: z.string().min(1).max(800),
  signals: z.array(z.string().max(200)).min(2).max(3),
  suggested_verdict: z.enum(["keep", "discard"]),
  suggested_reason: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1),
  usage: z.enum(["integrate", "reference"]),
  playbook: playbookSchema,
  tags: z.array(z.string().min(1).max(40).transform((t) => t.toLowerCase().trim())).min(1).max(6),
  source_url: z.string().url().nullable()
}).superRefine((card, ctx) => {
  if (card.type === "experience" && card.playbook.kind !== "experience") {
    ctx.addIssue({ code: "custom", path: ["playbook"], message: "experience type requires experience playbook" });
  }
  if (card.type !== "experience" && card.playbook.kind === "experience") {
    ctx.addIssue({ code: "custom", path: ["playbook"], message: "experience playbook requires experience type" });
  }
});
export type Card = z.infer<typeof cardSchema>;

export const reviewNoteSchema = z.object({ agrees: z.boolean(), points: z.array(z.string().max(300)).max(8) });
export type ReviewNote = z.infer<typeof reviewNoteSchema>;
```

- [ ] **Step 4: 运行确认通过** → 4 passed

- [ ] **Step 5: 提交**

```bash
git add lib/analysis/card.ts lib/analysis/card.test.ts && git commit -m "feat(analysis): capability card and extraction schemas"
```

---

### Task 9: Provider 适配器（MiniMax 视觉/JSON、MiniMax 搜索、Tavily、DeepSeek）

**Files:**
- Create: `lib/providers/minimax.ts`, `lib/providers/minimax.test.ts`, `lib/providers/minimax-search.ts`, `lib/providers/minimax-search.test.ts`, `lib/providers/tavily.ts`, `lib/providers/tavily.test.ts`, `lib/providers/deepseek.ts`, `lib/providers/deepseek.test.ts`, `lib/providers/prompt.ts`
- 来源：`$ALLJOBS/lib/assistant/minimax-token-plan-core.ts`（`createOpenAI` + M3 请求字段）、`$ALLJOBS/lib/caphub/providers/minimax-web-search.ts`（Responses API + `tools:[{type:"web_search"}]` 与 `url_citation` 解析）、`$ALLJOBS/lib/caphub/providers/deepseek-responses.ts`（Responses API + `text.format.json_schema`）

**Interfaces:**
- Consumes: `StructuredCall`, `StructuredInput` (Task 7)；`searchResultSchema`, `MAX_SOURCE_CONTENT`, `MAX_SOURCES` (Task 8)
- Produces:
  - `buildStructuredPrompt(input: StructuredInput): string`（把 schema JSON、纠错 issues 拼进提示）
  - `createMiniMaxCall(opts: { apiKey: string; fetch?: typeof fetch }): StructuredCall`（provider `"minimax"`, model `"MiniMax-M3"`；支持 images）
  - `createDeepSeekCall(opts: { apiKey: string; fetch?: typeof fetch }): StructuredCall`（provider `"deepseek"`, model `"deepseek-flash"`；忽略 images——调用方保证不传）
  - `type SearchCall = { provider: string; model: string; search(query: string, signal: AbortSignal): Promise<{ value: SearchResult; usage: { inputTokens: number; outputTokens: number } }> }`
  - `createMiniMaxSearch(opts): SearchCall`（model `"MiniMax-M3"`）
  - `createTavilySearch(opts: { apiKey: string; fetch? }): SearchCall`（provider `"tavily"`, model `"search"`, usage 全 0）
  - `truncateSources(sources): SearchResult["sources"]`（每条 content 截到 `MAX_SOURCE_CONTENT`，最多 `MAX_SOURCES` 条）

- [ ] **Step 1: 失败测试**（每个适配器一个注入 `fetch` 的测试；断言请求体形状与响应解析）

`lib/providers/minimax.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMiniMaxCall } from "./minimax";

describe("createMiniMaxCall", () => {
  it("posts chat completion with image part and parses JSON text", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        id: "x", object: "chat.completion", created: 1, model: "MiniMax-M3",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "{\"n\":1}" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const call = createMiniMaxCall({ apiKey: "k", fetch: fetchFn });
    const out = await call.invoke({ prompt: "p", images: [{ data: new Uint8Array([1, 2]), mediaType: "image/png" }], schemaName: "t", schema: z.object({ n: z.number() }) }, new AbortController().signal);
    expect(out).toEqual({ value: { n: 1 }, usage: { inputTokens: 10, outputTokens: 2 } });
    expect(body.model).toBe("MiniMax-M3");
    expect(JSON.stringify(body)).toContain("data:image/png;base64,");
    expect(body.thinking).toEqual({ type: "disabled" });
  });
  it("maps 401 to AUTHENTICATION", async () => {
    const fetchFn = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(createMiniMaxCall({ apiKey: "k", fetch: fetchFn }).invoke({ prompt: "p", schemaName: "t", schema: z.any() }, new AbortController().signal)).rejects.toMatchObject({ code: "AUTHENTICATION" });
  });
});
```

`lib/providers/minimax-search.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createMiniMaxSearch } from "./minimax-search";

describe("createMiniMaxSearch", () => {
  it("sends web_search tool and collects url_citation annotations, truncated", async () => {
    let body: Record<string, unknown> = {};
    const long = "x".repeat(5000);
    const fetchFn = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "summary", annotations: [
          { type: "url_citation", title: "A", url: "https://a.example/", content: long },
          { type: "url_citation", title: "B", url: "https://b.example/", content: "short" }
        ] }] }],
        usage: { input_tokens: 100, output_tokens: 5 }
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await createMiniMaxSearch({ apiKey: "k", fetch: fetchFn }).search("q", new AbortController().signal);
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(out.value.sources).toHaveLength(2);
    expect(out.value.sources[0].content).toHaveLength(2048);
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 5 });
  });
});
```

`lib/providers/tavily.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createTavilySearch } from "./tavily";

describe("createTavilySearch", () => {
  it("posts query with api key and maps results", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ results: Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, url: `https://s${i}.example/`, content: "c".repeat(3000) })) }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await createTavilySearch({ apiKey: "k", fetch: fetchFn }).search("q", new AbortController().signal);
    expect(body).toMatchObject({ query: "q", max_results: 6, include_answer: false });
    expect(out.value.sources).toHaveLength(6);
    expect(out.value.sources[0].content).toHaveLength(2048);
    expect(out.provider).toBe("tavily");
  });
});
```

`lib/providers/deepseek.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDeepSeekCall } from "./deepseek";

describe("createDeepSeekCall", () => {
  it("posts responses request with json_schema format and parses output", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "{\"n\":2}" }] }], usage: { input_tokens: 3, output_tokens: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await createDeepSeekCall({ apiKey: "k", fetch: fetchFn }).invoke({ prompt: "p", schemaName: "card", schema: z.object({ n: z.number() }) }, new AbortController().signal);
    expect(out.value).toEqual({ n: 2 });
    expect(body.model).toBe("deepseek-flash");
    expect((body.text as { format: { type: string; name: string } }).format).toMatchObject({ type: "json_schema", name: "card" });
    expect(JSON.stringify(body)).not.toMatch(/image/);
  });
});
```

- [ ] **Step 2: 运行确认失败** → `npx vitest run lib/providers` FAIL

- [ ] **Step 3: 实现**

`lib/providers/prompt.ts`:
```ts
import { z } from "zod";
import type { StructuredInput } from "../analysis/structured";

export function buildStructuredPrompt(input: StructuredInput): string {
  const schema = JSON.stringify(z.toJSONSchema(input.schema));
  const correction = input.correction
    ? `\n\n上一次输出未通过校验，问题：\n${input.correction.issues.map((i) => `- ${i}`).join("\n")}\n请修正后重新输出。`
    : "";
  return `${input.prompt}\n\n只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。JSON Schema：\n${schema}${correction}`;
}

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}
```

`lib/providers/minimax.ts`:
```ts
import type { StructuredCall, StructuredInput } from "../analysis/structured";
import { ProviderError, failureForHttpStatus } from "./errors";
import { buildStructuredPrompt, parseJsonObject } from "./prompt";

export const MINIMAX_BASE_URL = "https://api.minimax.io/v1";
export const MINIMAX_MODEL = "MiniMax-M3";

interface ChatCompletion {
  choices: Array<{ finish_reason: string; message: { content: string | null } }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

function toDataUrl(image: { data: Uint8Array; mediaType: string }): string {
  return `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`;
}

export function createMiniMaxCall(opts: { apiKey: string; fetch?: typeof fetch }): StructuredCall {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  return {
    provider: "minimax",
    model: MINIMAX_MODEL,
    async invoke(input: StructuredInput, signal: AbortSignal) {
      const content: Array<Record<string, unknown>> = [{ type: "text", text: buildStructuredPrompt(input) }];
      for (const image of input.images ?? []) content.push({ type: "image_url", image_url: { url: toDataUrl(image) } });
      let response: Response;
      try {
        response = await fetchFn(`${MINIMAX_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: MINIMAX_MODEL, messages: [{ role: "user", content }],
            max_tokens: 8192, temperature: 0.2, thinking: { type: "disabled" }, reasoning_split: true
          }),
          signal
        });
      } catch (error) {
        throw new ProviderError(signal.aborted ? "ABORTED" : "UNAVAILABLE", { cause: error });
      }
      if (!response.ok) throw new ProviderError(failureForHttpStatus(response.status));
      let payload: ChatCompletion;
      try { payload = await response.json() as ChatCompletion; } catch (error) { throw new ProviderError("INVALID_OUTPUT", { cause: error }); }
      const text = payload.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) throw new ProviderError("INVALID_OUTPUT");
      let value: unknown;
      try { value = parseJsonObject(text); } catch (error) { throw new ProviderError("INVALID_OUTPUT", { cause: error }); }
      return { value, usage: { inputTokens: payload.usage?.prompt_tokens ?? 0, outputTokens: payload.usage?.completion_tokens ?? 0 } };
    }
  };
}
```

`lib/providers/minimax-search.ts`:
```ts
import { z } from "zod";
import { MAX_SOURCES, MAX_SOURCE_CONTENT, searchResultSchema, type SearchResult } from "../analysis/card";
import { ProviderError, failureForHttpStatus } from "./errors";
import { MINIMAX_BASE_URL, MINIMAX_MODEL } from "./minimax";

export interface SearchCall {
  provider: string;
  model: string;
  search(query: string, signal: AbortSignal): Promise<{ value: SearchResult; usage: { inputTokens: number; outputTokens: number } }>;
}

export function truncateSources(sources: Array<{ title: string; url: string; content: string }>): SearchResult["sources"] {
  const seen = new Set<string>();
  const out: SearchResult["sources"] = [];
  for (const s of sources) {
    if (!s.url.startsWith("https://") || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({ title: s.title.slice(0, 300), url: s.url, content: s.content.slice(0, MAX_SOURCE_CONTENT) });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

const citation = z.object({ type: z.literal("url_citation"), title: z.string(), url: z.string(), content: z.string().default("") }).passthrough();
const responseSchema = z.object({
  status: z.string(),
  output: z.array(z.object({ type: z.string(), content: z.array(z.object({ type: z.string(), annotations: z.array(z.unknown()).default([]) }).passthrough()).default([]) }).passthrough()).default([]),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional()
}).passthrough();

export function createMiniMaxSearch(opts: { apiKey: string; fetch?: typeof fetch }): SearchCall {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  return {
    provider: "minimax",
    model: MINIMAX_MODEL,
    async search(query, signal) {
      let response: Response;
      try {
        response = await fetchFn(`${MINIMAX_BASE_URL}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: MINIMAX_MODEL, input: `搜索并给出与下面内容最相关的网页来源：\n${query}`, stream: false, tools: [{ type: "web_search" }] }),
          signal
        });
      } catch (error) {
        throw new ProviderError(signal.aborted ? "ABORTED" : "UNAVAILABLE", { cause: error });
      }
      if (!response.ok) throw new ProviderError(failureForHttpStatus(response.status));
      const parsed = responseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success || parsed.data.status !== "completed") throw new ProviderError("INVALID_OUTPUT");
      const annotations = parsed.data.output.flatMap((m) => m.content.flatMap((c) => c.annotations));
      const sources = annotations.map((a) => citation.safeParse(a)).filter((r) => r.success).map((r) => r.data);
      return {
        value: searchResultSchema.parse({ sources: truncateSources(sources) }),
        usage: { inputTokens: parsed.data.usage?.input_tokens ?? 0, outputTokens: parsed.data.usage?.output_tokens ?? 0 }
      };
    }
  };
}
```

`lib/providers/tavily.ts`:
```ts
import { z } from "zod";
import { MAX_SOURCES, searchResultSchema } from "../analysis/card";
import { ProviderError, failureForHttpStatus } from "./errors";
import { truncateSources, type SearchCall } from "./minimax-search";

const TAVILY_URL = "https://api.tavily.com/search";
const tavilySchema = z.object({ results: z.array(z.object({ title: z.string().default(""), url: z.string(), content: z.string().default("") })) }).passthrough();

export function createTavilySearch(opts: { apiKey: string; fetch?: typeof fetch }): SearchCall {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  return {
    provider: "tavily",
    model: "search",
    async search(query, signal) {
      let response: Response;
      try {
        response = await fetchFn(TAVILY_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ query, max_results: MAX_SOURCES, search_depth: "basic", include_answer: false, include_raw_content: false }),
          signal
        });
      } catch (error) {
        throw new ProviderError(signal.aborted ? "ABORTED" : "UNAVAILABLE", { cause: error });
      }
      if (!response.ok) throw new ProviderError(failureForHttpStatus(response.status));
      const parsed = tavilySchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new ProviderError("INVALID_OUTPUT");
      return { value: searchResultSchema.parse({ sources: truncateSources(parsed.data.results) }), usage: { inputTokens: 0, outputTokens: 0 } };
    }
  };
}
```

`lib/providers/deepseek.ts`:
```ts
import { z } from "zod";
import type { StructuredCall, StructuredInput } from "../analysis/structured";
import { ProviderError, failureForHttpStatus } from "./errors";
import { buildStructuredPrompt, parseJsonObject } from "./prompt";

export const DEEPSEEK_RESPONSES_URL = "https://api.deepseek.com/responses";
export const DEEPSEEK_MODEL = "deepseek-flash";

const responseSchema = z.object({
  status: z.string(),
  output: z.array(z.object({ type: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().default("") }).passthrough()).default([]) }).passthrough()).default([]),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional()
}).passthrough();

export function createDeepSeekCall(opts: { apiKey: string; fetch?: typeof fetch }): StructuredCall {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  return {
    provider: "deepseek",
    model: DEEPSEEK_MODEL,
    async invoke(input: StructuredInput, signal: AbortSignal) {
      if (input.images?.length) throw new ProviderError("INVALID_OUTPUT", { cause: new Error("deepseek call does not accept images") });
      let response: Response;
      try {
        response = await fetchFn(DEEPSEEK_RESPONSES_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: DEEPSEEK_MODEL, input: buildStructuredPrompt(input), stream: false,
            reasoning: { effort: "none" }, max_output_tokens: 8192,
            text: { format: { type: "json_schema", name: input.schemaName, schema: z.toJSONSchema(input.schema) } }
          }),
          signal
        });
      } catch (error) {
        throw new ProviderError(signal.aborted ? "ABORTED" : "UNAVAILABLE", { cause: error });
      }
      if (!response.ok) throw new ProviderError(failureForHttpStatus(response.status));
      const parsed = responseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success || parsed.data.status !== "completed") throw new ProviderError("INVALID_OUTPUT");
      const text = parsed.data.output.flatMap((m) => m.content).map((c) => c.text).find((t) => t.trim());
      if (!text) throw new ProviderError("INVALID_OUTPUT");
      let value: unknown;
      try { value = parseJsonObject(text); } catch (error) { throw new ProviderError("INVALID_OUTPUT", { cause: error }); }
      return { value, usage: { inputTokens: parsed.data.usage?.input_tokens ?? 0, outputTokens: parsed.data.usage?.output_tokens ?? 0 } };
    }
  };
}
```

- [ ] **Step 4: 运行确认通过** → `npx vitest run lib/providers` 5 passed

- [ ] **Step 5: 提交**

```bash
git add lib/providers && git commit -m "feat(providers): minimax, minimax search, tavily and deepseek adapters"
```

---

### Task 10: 素材准备（图片预处理、URL 抓取、文本）

**Files:**
- Create: `lib/analysis/material/image.ts`, `lib/analysis/material/image.test.ts`, `lib/analysis/material/url.ts`, `lib/analysis/material/url.test.ts`, `lib/analysis/material/index.ts`
- 来源：`$ALLJOBS/lib/caphub/preprocess/image.ts` 的 `inspectImage`、sharp 归一化与 `createPackagedTesseractRecognizer`（只复制这三段；不要 zxing 条码、感知哈希、privacy suggestions）

**Interfaces:**
- Produces:
  - `type Material = { kind: "image"; png: Uint8Array; ocrText: string; width: number; height: number } | { kind: "text"; text: string } | { kind: "url"; url: string; text: string | null }`
  - `prepareImage(bytes: Uint8Array, deps?: { ocr?: (png: Uint8Array) => Promise<string> }, signal?: AbortSignal): Promise<Material & { kind: "image" }>`（sharp → 最长边 ≤ 2000 px 的 PNG；OCR 超时 15 s，失败则 `ocrText = ""`）
  - `fetchUrlText(url: string, fetchFn?: typeof fetch): Promise<string | null>`（https only、15 s、≤ 20,480 字节、剥 HTML 标签与脚本、失败返回 null）
  - `prepareMaterial(capture: { kind; bytes?; text?; url? }, deps): Promise<Material>`

- [ ] **Step 1: 失败测试**

`lib/analysis/material/url.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fetchUrlText, stripHtml } from "./url";

describe("stripHtml", () => {
  it("removes scripts, styles and tags, collapses whitespace", () => {
    expect(stripHtml("<html><script>x()</script><style>a{}</style><p>Hello <b>world</b></p>\n\n<p>again</p></html>")).toBe("Hello world again");
  });
});
describe("fetchUrlText", () => {
  it("returns null for non-https", async () => { expect(await fetchUrlText("http://a.b")).toBeNull(); });
  it("caps body to 20480 bytes", async () => {
    const fetchFn = (async () => new Response("<p>" + "a".repeat(50000) + "</p>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const t = await fetchUrlText("https://a.b/", fetchFn);
    expect(t!.length).toBeLessThanOrEqual(20480);
  });
  it("returns null on non-2xx", async () => {
    const fetchFn = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchUrlText("https://a.b/", fetchFn)).toBeNull();
  });
});
```

`lib/analysis/material/image.test.ts`（用 sharp 现场生成一张 PNG）:
```ts
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { prepareImage } from "./image";

describe("prepareImage", () => {
  it("normalizes to png with bounded size and uses injected ocr", async () => {
    const jpeg = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    const m = await prepareImage(new Uint8Array(jpeg), { ocr: async () => "hello" });
    expect(m.kind).toBe("image");
    expect(m.width).toBe(2000);
    expect(m.ocrText).toBe("hello");
    expect((await sharp(m.png).metadata()).format).toBe("png");
  });
  it("tolerates ocr failure", async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } }).png().toBuffer();
    const m = await prepareImage(new Uint8Array(png), { ocr: async () => { throw new Error("boom"); } });
    expect(m.ocrText).toBe("");
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 实现**

`lib/analysis/material/url.ts`:
```ts
export const MAX_URL_BODY_BYTES = 20_480;
export const URL_TIMEOUT_MS = 15_000;

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
}

export async function fetchUrlText(url: string, fetchFn: typeof fetch = globalThis.fetch): Promise<string | null> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, { signal: controller.signal, redirect: "follow", headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.1", "user-agent": "caphub/2 (+https://caphub.agentjoey.ai)" } });
    if (!response.ok) return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_URL_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
    await reader.cancel().catch(() => {});
    const raw = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_URL_BODY_BYTES));
    const type = response.headers.get("content-type") ?? "";
    return type.includes("html") ? stripHtml(raw) : raw.replace(/\s+/g, " ").trim();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

`lib/analysis/material/image.ts`:
```ts
import sharp from "sharp";

export const MAX_EDGE_PX = 2000;
export const OCR_TIMEOUT_MS = 15_000;

export interface ImageMaterial { kind: "image"; png: Uint8Array; ocrText: string; width: number; height: number }

let recognizer: Promise<{ recognize(png: Uint8Array): Promise<string> }> | undefined;

async function packagedOcr(png: Uint8Array): Promise<string> {
  recognizer ??= (async () => {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker(["eng", "chi_sim"]);
    return { async recognize(bytes: Uint8Array) { const r = await worker.recognize(Buffer.from(bytes)); return r.data.text; } };
  })();
  return (await recognizer).recognize(png);
}

export async function prepareImage(
  bytes: Uint8Array,
  deps: { ocr?: (png: Uint8Array) => Promise<string> } = {},
  signal?: AbortSignal
): Promise<ImageMaterial> {
  const image = sharp(Buffer.from(bytes), { failOn: "error" }).rotate();
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error("INVALID_IMAGE");
  const resized = meta.width > MAX_EDGE_PX || meta.height > MAX_EDGE_PX ? image.resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: "inside" }) : image;
  const { data, info } = await resized.png().toBuffer({ resolveWithObject: true });
  const png = new Uint8Array(data);
  const ocr = deps.ocr ?? packagedOcr;
  let ocrText = "";
  try {
    ocrText = await Promise.race([
      ocr(png),
      new Promise<string>((_r, reject) => {
        const t = setTimeout(() => reject(new Error("OCR_TIMEOUT")), OCR_TIMEOUT_MS);
        signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("ABORTED")); }, { once: true });
      })
    ]);
  } catch {
    ocrText = "";
  }
  return { kind: "image", png, ocrText: ocrText.replace(/\s+/g, " ").trim().slice(0, 8000), width: info.width, height: info.height };
}
```

`lib/analysis/material/index.ts`:
```ts
import { prepareImage, type ImageMaterial } from "./image";
import { fetchUrlText } from "./url";

export type Material = ImageMaterial | { kind: "text"; text: string } | { kind: "url"; url: string; text: string | null };

export interface MaterialDeps { ocr?: (png: Uint8Array) => Promise<string>; fetch?: typeof fetch }

export async function prepareMaterial(
  capture: { kind: "image" | "text" | "url"; bytes?: Uint8Array; text?: string | null; url?: string | null },
  deps: MaterialDeps = {},
  signal?: AbortSignal
): Promise<Material> {
  switch (capture.kind) {
    case "image": return prepareImage(capture.bytes!, { ocr: deps.ocr }, signal);
    case "text": return { kind: "text", text: capture.text! };
    case "url": return { kind: "url", url: capture.url!, text: await fetchUrlText(capture.url!, deps.fetch) };
  }
}
```

- [ ] **Step 4: 运行确认通过** → `npx vitest run lib/analysis/material` 6 passed

- [ ] **Step 5: 提交**

```bash
git add lib/analysis/material && git commit -m "feat(analysis): image, url and text material preparation"
```

---

### Task 11: 管线、裁决、能力落库、标签

**Files:**
- Create: `lib/analysis/prompts.ts`, `lib/analysis/pipeline.ts`, `lib/analysis/pipeline.test.ts`, `lib/analysis/verdict.ts`, `lib/analysis/verdict.test.ts`, `lib/analysis/capabilities.ts`, `lib/analysis/tags.ts`, `lib/analysis/similar.ts`

**Interfaces:**
- Consumes: Task 7–10 全部；`RunQueue.Lease`
- Produces:
  - `decideVerdict(card: Pick<Card, "suggested_verdict" | "confidence">, threshold: number): { verdict: "keep" | "discard" | "pending"; by: "auto" | null }`
  - `type PipelineDeps = { pool: Pool; objects: ObjectStore; vision: StructuredCall; search: SearchCall; reason: StructuredCall; material: MaterialDeps; threshold: number }`
  - `createPipelineDeps(config: Config, pool, objects, pipeline: Pipeline): PipelineDeps`（A：vision/reason 都是 MiniMax，search 是 MiniMax；B：vision MiniMax，search Tavily，reason DeepSeek）
  - `runPipeline(deps: PipelineDeps, lease: Lease, signal: AbortSignal): Promise<{ capabilityId: string; verdict: string }>`（失败抛 `ProviderError` 或 `Error`；调用方 finish）
  - `upsertCapability(pool, row: { captureId; runId; card: Card; verdict; verdictBy }): Promise<string>`（同一 capture 重跑则覆盖卡片字段，但**保留人工裁决**：若已有行 `verdict_by = 'human'` 则只更新卡片字段，不动 verdict）
  - `bumpTags(pool, tags: string[]): Promise<void>`；`topTags(pool, limit = 100): Promise<string[]>`
  - `findSimilar(pool, text: string, limit = 5): Promise<Array<{ id; title; tags }>>`（全文检索 `plainto_tsquery('simple', …)`，只查 `verdict = 'keep'`）
  - prompts：`visionPrompt(ocrText: string): string`；`searchQuery(extraction: Extraction | null, material: Material): string`；`reasonPrompt(input: { material: Material; extraction: Extraction | null; sources: SearchResult["sources"]; similar; existingTags: string[] }): string`

- [ ] **Step 1: 失败测试**

`lib/analysis/verdict.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { decideVerdict } from "./verdict";

describe("decideVerdict", () => {
  it("auto-applies confident suggestions", () => {
    expect(decideVerdict({ suggested_verdict: "keep", confidence: 0.8 }, 0.8)).toEqual({ verdict: "keep", by: "auto" });
    expect(decideVerdict({ suggested_verdict: "discard", confidence: 0.95 }, 0.8)).toEqual({ verdict: "discard", by: "auto" });
  });
  it("leaves uncertain ones pending", () => {
    expect(decideVerdict({ suggested_verdict: "keep", confidence: 0.79 }, 0.8)).toEqual({ verdict: "pending", by: null });
  });
});
```

`lib/analysis/pipeline.test.ts`（全假依赖；断言 step 顺序、文本输入跳过 vision、卡片落库参数）:
```ts
import { describe, expect, it } from "vitest";
import { runPipeline, type PipelineDeps } from "./pipeline";

const card = {
  title: "t", type: "prompt", summary: "s", signals: ["a", "b"], suggested_verdict: "keep", suggested_reason: "r",
  confidence: 0.9, usage: "integrate", playbook: { kind: "integrate", install: [], repo: null, prompt_text: "p" }, tags: ["x"], source_url: null
};
const extraction = { what: "w", visible_text: "", commands: [], prompt_text: null, source_hints: [], questions: [] };

function deps(kind: "image" | "text") {
  const calls: string[] = [];
  const sql: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values: unknown[] = []) => {
      sql.push({ text, values });
      if (text.startsWith("SELECT kind, object_key")) return { rows: [{ kind, object_key: kind === "image" ? "sha256/aa/" + "a".repeat(64) : null, mime_type: "image/png", text: kind === "text" ? "hello" : null, url: null }] };
      if (text.startsWith("SELECT name FROM caphub_v2.tags")) return { rows: [{ name: "x" }] };
      if (text.startsWith("SELECT id, title, tags FROM caphub_v2.capabilities")) return { rows: [] };
      if (text.startsWith("INSERT INTO caphub_v2.capabilities")) return { rows: [{ id: "cab_1", verdict: "keep" }] };
      return { rows: [] };
    }
  };
  const d: PipelineDeps = {
    pool: pool as never,
    objects: { get: async () => new Uint8Array([1]) } as never,
    vision: { provider: "minimax", model: "m", invoke: async () => { calls.push("vision"); return { value: extraction, usage: { inputTokens: 1, outputTokens: 1 } }; } },
    search: { provider: "tavily", model: "s", search: async () => { calls.push("search"); return { value: { sources: [] }, usage: { inputTokens: 0, outputTokens: 0 } }; } },
    reason: { provider: "deepseek", model: "d", invoke: async () => { calls.push("reason"); return { value: card, usage: { inputTokens: 1, outputTokens: 1 } }; } },
    material: { ocr: async () => "" },
    threshold: 0.8
  };
  return { d, calls, sql };
}

describe("runPipeline", () => {
  it("runs vision → search → reason for images and stores an auto-kept capability", async () => {
    const { d, calls, sql } = deps("image");
    // sharp 需要真实 PNG：用 1x1 PNG 替换 objects.get
    const sharp = (await import("sharp")).default;
    const png = new Uint8Array(await sharp({ create: { width: 1, height: 1, channels: 3, background: "#fff" } }).png().toBuffer());
    d.objects = { get: async () => png } as never;
    const out = await runPipeline(d, { runId: "run_1", captureId: "cap_1", pipeline: "mixed", ownerToken: "t" }, new AbortController().signal);
    expect(calls).toEqual(["vision", "search", "reason"]);
    expect(out).toEqual({ capabilityId: "cab_1", verdict: "keep" });
    const insert = sql.find((q) => q.text.startsWith("INSERT INTO caphub_v2.capabilities"))!;
    expect(insert.values).toContain("auto");
  });
  it("skips vision for text", async () => {
    const { d, calls } = deps("text");
    await runPipeline(d, { runId: "run_2", captureId: "cap_2", pipeline: "minimax", ownerToken: "t" }, new AbortController().signal);
    expect(calls).toEqual(["search", "reason"]);
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 实现**

`lib/analysis/verdict.ts`:
```ts
import type { Card } from "./card";

export function decideVerdict(card: Pick<Card, "suggested_verdict" | "confidence">, threshold: number): { verdict: "keep" | "discard" | "pending"; by: "auto" | null } {
  if (card.confidence >= threshold) return { verdict: card.suggested_verdict, by: "auto" };
  return { verdict: "pending", by: null };
}
```

`lib/analysis/tags.ts`:
```ts
import type { Pool } from "pg";

export async function topTags(pool: Pick<Pool, "query">, limit = 100): Promise<string[]> {
  const r = await pool.query<{ name: string }>("SELECT name FROM caphub_v2.tags ORDER BY use_count DESC, name LIMIT $1", [limit]);
  return r.rows.map((x) => x.name);
}

export async function bumpTags(pool: Pick<Pool, "query">, tags: string[]): Promise<void> {
  if (!tags.length) return;
  await pool.query(
    "INSERT INTO caphub_v2.tags (name, use_count) SELECT unnest($1::text[]), 1 ON CONFLICT (name) DO UPDATE SET use_count = caphub_v2.tags.use_count + 1",
    [tags]);
}
```

`lib/analysis/similar.ts`:
```ts
import type { Pool } from "pg";

export async function findSimilar(pool: Pick<Pool, "query">, text: string, limit = 5): Promise<Array<{ id: string; title: string; tags: string[] }>> {
  const q = text.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!q) return [];
  const r = await pool.query<{ id: string; title: string; tags: string[] }>(
    `SELECT id, title, tags FROM caphub_v2.capabilities
     WHERE verdict = 'keep' AND deleted_at IS NULL AND search @@ plainto_tsquery('simple', $1)
     ORDER BY ts_rank(search, plainto_tsquery('simple', $1)) DESC LIMIT $2`, [q, limit]);
  return r.rows;
}
```

`lib/analysis/prompts.ts`:
```ts
import type { Extraction, SearchResult } from "./card";
import type { Material } from "./material";

export function visionPrompt(ocrText: string): string {
  return [
    "你在整理一个个人 agent 能力库。请仔细看这张图片，提取其中关于「能力」（skill、经验、plugin、prompt 等）的信息。",
    "要求：what 用一两句话说明图里展示的是什么能力；visible_text 抄录图中可见的关键文字；commands 抄录可见的安装/运行命令；prompt_text 若图中有完整提示词原文则逐字抄录否则为 null；source_hints 列出可见的作者、仓库、网址、产品名；questions 列出看图无法确定、需要联网核实的问题（最多 5 条）。",
    ocrText ? `OCR 参考文本（可能有错）：\n${ocrText}` : ""
  ].filter(Boolean).join("\n\n");
}

export function searchQuery(extraction: Extraction | null, material: Material): string {
  if (extraction) return [extraction.what, ...extraction.source_hints, ...extraction.questions.slice(0, 2)].join(" ").slice(0, 400);
  if (material.kind === "url") return material.url;
  return material.kind === "text" ? material.text.slice(0, 400) : "";
}

export function reasonPrompt(input: {
  material: Material; extraction: Extraction | null; sources: SearchResult["sources"];
  similar: Array<{ id: string; title: string; tags: string[] }>; existingTags: string[];
}): string {
  const materialText = input.material.kind === "text" ? input.material.text
    : input.material.kind === "url" ? `URL: ${input.material.url}\n页面正文：${input.material.text ?? "（抓取失败）"}`
    : `（图片，见视觉提取结果）`;
  return [
    "你在为一个个人 agent 能力库做评估与建档。能力类型：skill（可安装/可执行的技能）、experience（做法/教训，需保留核心内容本身）、plugin、prompt、other。",
    `原始输入：\n${materialText}`,
    input.extraction ? `视觉提取结果：\n${JSON.stringify(input.extraction)}` : "",
    input.sources.length ? `联网来源（已截断）：\n${input.sources.map((s, i) => `[${i + 1}] ${s.title} ${s.url}\n${s.content}`).join("\n\n")}` : "联网来源：无",
    input.similar.length ? `库里已有的相似能力（判断是否重叠）：\n${input.similar.map((s) => `- ${s.title} [${s.tags.join(", ")}]`).join("\n")}` : "库里没有相似能力。",
    `已有标签（优先复用）：${input.existingTags.join(", ") || "（空）"}`,
    "请输出 CapabilityCard：title ≤ 30 字的一句话；type；summary 是对整个分析的完整摘要（结论 + 依据，≤ 300 字）；signals 给 2–3 条价值信号（如解决什么场景、与库内谁重叠、来源可信度）；suggested_verdict 与 suggested_reason；confidence 是你对该建议的把握（0–1）；usage 在 integrate（可直接拿来用）与 reference（值得借鉴后自研）之间选；playbook 按 usage/type 给可执行内容：integrate 给 install 命令、repo、prompt 全文；reference 给借鉴要点；experience 类型必须把核心内容本身写进 content；tags 1–6 个小写标签；source_url 给最可信的来源链接或 null。"
  ].filter(Boolean).join("\n\n");
}
```

`lib/analysis/capabilities.ts`:
```ts
import type { Pool } from "pg";
import { newId } from "../ids";
import type { Card } from "./card";

export async function upsertCapability(
  pool: Pick<Pool, "query">,
  row: { captureId: string; runId: string; card: Card; verdict: "keep" | "discard" | "pending"; verdictBy: "auto" | null }
): Promise<{ id: string; verdict: string }> {
  const c = row.card;
  const r = await pool.query<{ id: string; verdict: string }>(
    `INSERT INTO caphub_v2.capabilities
       (id, capture_id, run_id, title, type, summary, signals, suggested_verdict, suggested_reason, confidence,
        verdict, verdict_by, verdict_at, usage, playbook, tags, source_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $12::text IS NULL THEN NULL ELSE now() END, $13, $14, $15, $16)
     ON CONFLICT (capture_id) DO UPDATE SET
       run_id = excluded.run_id, title = excluded.title, type = excluded.type, summary = excluded.summary,
       signals = excluded.signals, suggested_verdict = excluded.suggested_verdict, suggested_reason = excluded.suggested_reason,
       confidence = excluded.confidence, usage = excluded.usage, playbook = excluded.playbook, tags = excluded.tags,
       source_url = excluded.source_url, review_note = NULL, notified_at = NULL, updated_at = now(),
       verdict = CASE WHEN caphub_v2.capabilities.verdict_by = 'human' THEN caphub_v2.capabilities.verdict ELSE excluded.verdict END,
       verdict_by = CASE WHEN caphub_v2.capabilities.verdict_by = 'human' THEN 'human' ELSE excluded.verdict_by END,
       verdict_at = CASE WHEN caphub_v2.capabilities.verdict_by = 'human' THEN caphub_v2.capabilities.verdict_at ELSE excluded.verdict_at END
     RETURNING id, verdict`,
    [newId("cab"), row.captureId, row.runId, c.title, c.type, c.summary, JSON.stringify(c.signals), c.suggested_verdict, c.suggested_reason,
      c.confidence, row.verdict, row.verdictBy, c.usage, JSON.stringify(c.playbook), c.tags, c.source_url]);
  return r.rows[0];
}
```

`lib/analysis/pipeline.ts`:
```ts
import type { Pool } from "pg";
import type { Config, Pipeline } from "../config";
import { createDeepSeekCall } from "../providers/deepseek";
import { createMiniMaxCall } from "../providers/minimax";
import { createMiniMaxSearch, type SearchCall } from "../providers/minimax-search";
import { createTavilySearch } from "../providers/tavily";
import type { Lease } from "../queue/runs";
import type { ObjectStore } from "../storage/s3";
import { RunBudget } from "./budget";
import { upsertCapability } from "./capabilities";
import { cardSchema, extractionSchema, type Extraction } from "./card";
import { prepareMaterial, type MaterialDeps } from "./material";
import { reasonPrompt, searchQuery, visionPrompt } from "./prompts";
import { findSimilar } from "./similar";
import { recordStep } from "./steps";
import { runStructured, type StructuredCall } from "./structured";
import { bumpTags, topTags } from "./tags";
import { decideVerdict } from "./verdict";

export const TIMEOUTS = { vision: 60_000, search: 60_000, reason: 120_000, review: 120_000 } as const;

export interface PipelineDeps {
  pool: Pool; objects: ObjectStore; vision: StructuredCall; search: SearchCall; reason: StructuredCall;
  material: MaterialDeps; threshold: number;
}

export function createPipelineDeps(config: Config, pool: Pool, objects: ObjectStore, pipeline: Pipeline): PipelineDeps {
  const minimax = createMiniMaxCall({ apiKey: config.providers.minimaxApiKey });
  if (pipeline === "mixed") {
    return {
      pool, objects, vision: minimax,
      search: createTavilySearch({ apiKey: config.providers.tavilyApiKey! }),
      reason: createDeepSeekCall({ apiKey: config.providers.deepseekApiKey }),
      material: {}, threshold: config.verdictAutoThreshold
    };
  }
  return { pool, objects, vision: minimax, search: createMiniMaxSearch({ apiKey: config.providers.minimaxApiKey }), reason: minimax, material: {}, threshold: config.verdictAutoThreshold };
}

async function runSearch(deps: PipelineDeps, runId: string, query: string, budget: RunBudget, signal: AbortSignal) {
  if (!query.trim()) return { sources: [] };
  budget.assertCanCall();
  budget.calls += 1;
  const started = Date.now();
  const base = { runId, step: "search" as const, provider: deps.search.provider, model: deps.search.model, attempt: 1 };
  const t = new AbortController();
  const timer = setTimeout(() => t.abort(), TIMEOUTS.search);
  signal.addEventListener("abort", () => t.abort(), { once: true });
  try {
    const out = await deps.search.search(query, t.signal);
    budget.charge(out.usage.inputTokens + out.usage.outputTokens);
    await recordStep(deps.pool, { ...base, inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens, durationMs: Date.now() - started, ok: true, output: out.value });
    return out.value;
  } catch (error) {
    // 搜索失败不致命：记录后继续，reason 仍可基于素材给卡
    await recordStep(deps.pool, { ...base, durationMs: Date.now() - started, ok: false, error: error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "UNAVAILABLE" });
    return { sources: [] };
  } finally {
    clearTimeout(timer);
  }
}

export async function runPipeline(deps: PipelineDeps, lease: Lease, signal: AbortSignal): Promise<{ capabilityId: string; verdict: string }> {
  const capture = (await deps.pool.query<{ kind: "image" | "text" | "url"; object_key: string | null; mime_type: string | null; text: string | null; url: string | null }>(
    "SELECT kind, object_key, mime_type, text, url FROM caphub_v2.captures WHERE id = $1", [lease.captureId])).rows[0];
  if (!capture) throw new Error("CAPTURE_NOT_FOUND");
  const bytes = capture.object_key ? await deps.objects.get({ key: capture.object_key, digest: capture.object_key.split("/")[2], bytes: 0 }).catch(() => null) : null;
  const material = await prepareMaterial({ kind: capture.kind, bytes: bytes ?? undefined, text: capture.text, url: capture.url }, deps.material, signal);
  const budget = new RunBudget();

  let extraction: Extraction | null = null;
  if (material.kind === "image") {
    extraction = await runStructured({
      pool: deps.pool, runId: lease.runId, step: "vision", call: deps.vision,
      prompt: visionPrompt(material.ocrText), images: [{ data: material.png, mediaType: "image/png" }],
      schemaName: "extraction", schema: extractionSchema, budget, timeoutMs: TIMEOUTS.vision, signal
    });
  }

  const search = await runSearch(deps, lease.runId, searchQuery(extraction, material), budget, signal);
  const similarSeed = extraction?.what ?? (material.kind === "text" ? material.text : material.kind === "url" ? material.text ?? material.url : "");
  const [similar, existingTags] = await Promise.all([findSimilar(deps.pool, similarSeed), topTags(deps.pool)]);

  const card = await runStructured({
    pool: deps.pool, runId: lease.runId, step: "reason", call: deps.reason,
    prompt: reasonPrompt({ material, extraction, sources: search.sources, similar, existingTags }),
    schemaName: "capability_card", schema: cardSchema, budget, timeoutMs: TIMEOUTS.reason, signal
  });

  const decision = decideVerdict(card, deps.threshold);
  const stored = await upsertCapability(deps.pool, { captureId: lease.captureId, runId: lease.runId, card, verdict: decision.verdict, verdictBy: decision.by });
  if (stored.verdict === "keep") await bumpTags(deps.pool, card.tags);
  return { capabilityId: stored.id, verdict: stored.verdict };
}
```

`ObjectStore.get` 需要 `bytes` 做校验，而 captures 表没存对象字节数——在 Task 4 的 `ObjectStore.get` 中把 `bytes: 0` 视为「跳过长度校验，只校验 digest」：`if ((ref.bytes !== 0 && bytes.byteLength !== ref.bytes) || sha256Hex(bytes) !== ref.digest) throw new ObjectMismatchError();`，并把 `objectRefSchema.bytes` 改为 `z.number().int().nonnegative()`。同步更新 Task 4 的测试预期（`bytes: 0` 可通过）。

- [ ] **Step 4: 运行确认通过** → `npx vitest run lib/analysis lib/storage` 全部通过

- [ ] **Step 5: 提交**

```bash
git add lib/analysis lib/storage && git commit -m "feat(analysis): A/B pipeline, tiered verdict, capability upsert and tags"
```

---

### Task 12: Worker 进程（队列消费 + 保留期清扫）

**Files:**
- Create: `lib/worker/tick.ts`, `lib/worker/tick.test.ts`, `lib/retention/retention.ts`, `lib/retention/retention.test.ts`, `scripts/worker.ts`
- 来源：`$ALLJOBS/lib/caphub/automation/worker.ts`（心跳/abort 结构）、`$ALLJOBS/lib/caphub/automation/retention.ts`（advisory lock + 引用检查 + dry-run）、`$ALLJOBS/scripts/caphub-worker.ts`（daemon 循环）

**Interfaces:**
- Consumes: `RunQueue` (Task 6)、`runPipeline` / `createPipelineDeps` (Task 11)、`ObjectStore.deleteExact` (Task 4)
- Produces:
  - `runTick(deps: { queue: Pick<RunQueue, "claim" | "heartbeat" | "finish">; run(lease: Lease, signal: AbortSignal): Promise<unknown>; clock(): Date; ownerToken(): string }, signal: AbortSignal): Promise<"idle" | "processed">`（心跳 30 s；`run` 抛错 → `finish({state:"failed", errorCode, errorMessage})`，心跳丢失 → abort 且不 finish）
  - `sweepRetention(deps: { pool: Pool; objects: Pick<ObjectStore, "deleteExact"> }, opts: { now: Date; dryRun: boolean; limit?: number }): Promise<Array<{ objectKey: string; state: "eligible" | "purged" | "failed" | "skipped" }>>`（`skipped` = 仍被未软删 30 天内的 capture 引用；软删 capability 的对象在 `deleted_at + 30d` 后才可删）
  - `scripts/worker.ts`：`--once | --daemon | --dry-run`；daemon 每 2 s 一 tick，每小时一次清扫；SIGTERM 优雅退出

- [ ] **Step 1: 失败测试**

`lib/worker/tick.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { runTick } from "./tick";

const lease = { runId: "run_1", captureId: "cap_1", pipeline: "minimax" as const, ownerToken: "t" };

describe("runTick", () => {
  it("returns idle when nothing to claim", async () => {
    const queue = { claim: async () => null, heartbeat: async () => true, finish: async () => true };
    expect(await runTick({ queue, run: async () => {}, clock: () => new Date(), ownerToken: () => "t" }, new AbortController().signal)).toBe("idle");
  });
  it("finishes done on success and failed with code on error", async () => {
    const finished: unknown[] = [];
    const queue = { claim: async () => lease, heartbeat: async () => true, finish: async (_l: unknown, o: unknown) => { finished.push(o); return true; } };
    await runTick({ queue, run: async () => {}, clock: () => new Date(), ownerToken: () => "t" }, new AbortController().signal);
    await runTick({ queue, run: async () => { throw Object.assign(new Error("x"), { code: "TIMEOUT" }); }, clock: () => new Date(), ownerToken: () => "t" }, new AbortController().signal);
    expect(finished).toEqual([{ state: "done" }, { state: "failed", errorCode: "TIMEOUT", errorMessage: "x" }]);
  });
});
```

`lib/retention/retention.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { sweepRetention } from "./retention";

describe("sweepRetention", () => {
  it("dry-run reports eligible without deleting", async () => {
    const deleted: string[] = [];
    const key = "sha256/aa/" + "a".repeat(64);
    const client = {
      async query(text: string) {
        if (text.startsWith("SELECT object_key FROM caphub_v2.retention")) return { rows: [{ object_key: key }] };
        if (text.startsWith("SELECT count(*)")) return { rows: [{ live: "0" }] };
        return { rows: [] };
      },
      release() {}
    };
    const pool = { connect: async () => client, query: client.query } as never;
    const out = await sweepRetention({ pool, objects: { deleteExact: async (k: string) => { deleted.push(k); } } }, { now: new Date(), dryRun: true });
    expect(out).toEqual([{ objectKey: key, state: "eligible" }]);
    expect(deleted).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 实现**

`lib/worker/tick.ts`:
```ts
import type { Lease, RunQueue } from "../queue/runs";

export interface TickDeps {
  queue: Pick<RunQueue, "claim" | "heartbeat" | "finish">;
  run(lease: Lease, signal: AbortSignal): Promise<unknown>;
  clock(): Date;
  ownerToken(): string;
}

export async function runTick(deps: TickDeps, signal: AbortSignal): Promise<"idle" | "processed"> {
  if (signal.aborted) return "idle";
  const lease = await deps.queue.claim(deps.ownerToken(), deps.clock());
  if (!lease) return "idle";
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  let renewal: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = deps.queue.heartbeat(lease, deps.clock())
      .then((owned) => { if (!owned) controller.abort(); })
      .catch(() => controller.abort())
      .finally(() => { renewal = undefined; });
  }, 30_000);
  try {
    await deps.run(lease, controller.signal);
    if (!controller.signal.aborted) await deps.queue.finish(lease, { state: "done" }, deps.clock());
  } catch (error) {
    if (!controller.signal.aborted) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "UNAVAILABLE";
      await deps.queue.finish(lease, { state: "failed", errorCode: code, errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error) }, deps.clock());
    }
  } finally {
    clearInterval(heartbeat);
    signal.removeEventListener("abort", abort);
    await renewal;
  }
  return "processed";
}
```

`lib/retention/retention.ts`:
```ts
import type { Pool } from "pg";
import type { ObjectStore } from "../storage/s3";

export interface SweepOutcome { objectKey: string; state: "eligible" | "purged" | "failed" | "skipped" }

export async function sweepRetention(
  deps: { pool: Pool; objects: Pick<ObjectStore, "deleteExact"> },
  opts: { now: Date; dryRun: boolean; limit?: number }
): Promise<SweepOutcome[]> {
  const limit = opts.limit ?? 25;
  const now = opts.now.toISOString();
  const due = await deps.pool.query<{ object_key: string }>(
    "SELECT object_key FROM caphub_v2.retention WHERE purged_at IS NULL AND eligible_at <= $1 ORDER BY object_key LIMIT $2", [now, limit]);
  const out: SweepOutcome[] = [];
  for (const { object_key } of due.rows) {
    const db = await deps.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtext('caphub_v2.object'), hashtext($1))", [object_key]);
      // 仍被「未软删的 capability」或「软删未满 30 天的 capability」引用则跳过
      const live = await db.query<{ live: string }>(
        `SELECT count(*)::text AS live FROM caphub_v2.captures c
         LEFT JOIN caphub_v2.capabilities cb ON cb.capture_id = c.id
         WHERE c.object_key = $1 AND cb.id IS NOT NULL AND cb.verdict = 'keep'
           AND (cb.deleted_at IS NULL OR cb.deleted_at > $2::timestamptz - interval '30 days')`, [object_key, now]);
      if (Number(live.rows[0].live) > 0) { await db.query("COMMIT"); out.push({ objectKey: object_key, state: "skipped" }); continue; }
      if (opts.dryRun) { await db.query("COMMIT"); out.push({ objectKey: object_key, state: "eligible" }); continue; }
      try {
        await deps.objects.deleteExact(object_key);
      } catch {
        await db.query("UPDATE caphub_v2.retention SET error_code = 'OBJECT_DELETE_FAILED' WHERE object_key = $1", [object_key]);
        await db.query("COMMIT");
        out.push({ objectKey: object_key, state: "failed" });
        continue;
      }
      await db.query("UPDATE caphub_v2.retention SET purged_at = $2, error_code = NULL WHERE object_key = $1", [object_key, now]);
      await db.query("COMMIT");
      out.push({ objectKey: object_key, state: "purged" });
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  return out;
}
```

`scripts/worker.ts`:
```ts
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { createObjectStore } from "../lib/storage/s3";
import { RunQueue } from "../lib/queue/runs";
import { createPipelineDeps, runPipeline } from "../lib/analysis/pipeline";
import { runTick } from "../lib/worker/tick";
import { sweepRetention } from "../lib/retention/retention";

type Mode = "dry-run" | "once" | "daemon";
function parseArgs(args: string[]): Mode {
  const a = args[0] ?? "--dry-run";
  if (!["--dry-run", "--once", "--daemon"].includes(a)) throw new Error("usage: worker [--dry-run|--once|--daemon]");
  return a.slice(2) as Mode;
}

async function main() {
  const mode = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const objects = createObjectStore(config.s3);
  const queue = new RunQueue(pool);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  const log = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`);
  try {
    if (mode === "dry-run") { log({ pipeline: config.pipeline, queue: await queue.summary() }); return; }
    const deps = createPipelineDeps(config, pool, objects, config.pipeline);
    let nextRetention = 0;
    do {
      if (config.retentionEnabled && Date.now() >= nextRetention) {
        nextRetention = Date.now() + 3_600_000;
        sweepRetention({ pool, objects }, { now: new Date(), dryRun: false })
          .then((r) => log({ retention: r.length ? r : "nothing due" }))
          .catch((e) => log({ retentionError: e instanceof Error ? e.message : String(e) }));
      }
      try {
        const state = config.analysisEnabled
          ? await runTick({ queue, run: (lease, signal) => runPipeline({ ...deps, pool }, lease, signal), clock: () => new Date(), ownerToken: randomUUID }, controller.signal)
          : "disabled";
        if (state !== "idle") log({ tick: state });
      } catch (e) {
        log({ tickError: e instanceof Error ? e.message : String(e) });
        if (mode === "once") process.exitCode = 1;
      }
      if (mode !== "daemon") break;
      await delay(2_000, undefined, { signal: controller.signal }).catch(() => {});
    } while (!controller.signal.aborted);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { process.stderr.write(`worker failed: ${e instanceof Error ? e.message : e}\n`); process.exitCode = 1; });
```

- [ ] **Step 4: 运行确认通过** → `npx vitest run lib/worker lib/retention` 3 passed；`npm run typecheck` 无错

- [ ] **Step 5: 提交**

```bash
git add lib/worker lib/retention scripts/worker.ts && git commit -m "feat(worker): queue consumer with heartbeat and hourly retention sweep"
```

---

### Task 13: 人工触发复核（DeepSeek）

**Files:**
- Create: `lib/analysis/review.ts`, `lib/analysis/review.test.ts`

**Interfaces:**
- Consumes: `runStructured`、`reviewNoteSchema`、`createDeepSeekCall`
- Produces: `reviewCapability(deps: { pool: Pool; call: StructuredCall }, capabilityId: string, signal: AbortSignal): Promise<ReviewNote>`（读取卡片 + 该 run 的 reason step `output`，调用一次 DeepSeek，写 `review_note`，写一行 `analysis_steps(step='review')`；不改 verdict）

- [ ] **Step 1: 失败测试**

`lib/analysis/review.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { reviewCapability } from "./review";

describe("reviewCapability", () => {
  it("stores review note without touching verdict", async () => {
    const sql: Array<{ text: string; values: unknown[] }> = [];
    const pool = { query: async (text: string, values: unknown[] = []) => {
      sql.push({ text, values });
      if (text.startsWith("SELECT cb.run_id")) return { rows: [{ run_id: "run_1", card: { title: "t" }, reason_output: { title: "t" } }] };
      return { rows: [] };
    } } as never;
    const call = { provider: "deepseek", model: "d", invoke: async () => ({ value: { agrees: false, points: ["p"] }, usage: { inputTokens: 1, outputTokens: 1 } }) };
    const note = await reviewCapability({ pool, call }, "cab_1", new AbortController().signal);
    expect(note).toEqual({ agrees: false, points: ["p"] });
    const update = sql.find((q) => q.text.startsWith("UPDATE caphub_v2.capabilities SET review_note"))!;
    expect(update.text).not.toMatch(/verdict/);
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 实现**

`lib/analysis/review.ts`:
```ts
import type { Pool } from "pg";
import { RunBudget } from "./budget";
import { reviewNoteSchema, type ReviewNote } from "./card";
import { TIMEOUTS } from "./pipeline";
import { runStructured, type StructuredCall } from "./structured";

export async function reviewCapability(deps: { pool: Pool; call: StructuredCall }, capabilityId: string, signal: AbortSignal): Promise<ReviewNote> {
  const row = (await deps.pool.query<{ run_id: string; card: unknown; reason_output: unknown }>(
    `SELECT cb.run_id, to_jsonb(cb) - 'search' AS card,
            (SELECT output FROM caphub_v2.analysis_steps s WHERE s.run_id = cb.run_id AND s.step = 'reason' AND s.ok ORDER BY id DESC LIMIT 1) AS reason_output
     FROM caphub_v2.capabilities cb WHERE cb.id = $1`, [capabilityId])).rows[0];
  if (!row) throw new Error("CAPABILITY_NOT_FOUND");
  const prompt = [
    "你是第二意见评审。下面是一张由另一个模型生成的能力卡片及其完整推理产物。请独立判断：建议的保留/丢弃、类型、integrate/reference、标签是否合理；摘要有没有夸大或遗漏。",
    `卡片：\n${JSON.stringify(row.card)}`,
    `推理产物：\n${JSON.stringify(row.reason_output)}`,
    "输出 agrees（整体是否同意）和 points（不同意或需要修正的具体点，最多 8 条；同意则给 1–2 条确认理由）。"
  ].join("\n\n");
  const note = await runStructured({
    pool: deps.pool, runId: row.run_id, step: "review", call: deps.call, prompt,
    schemaName: "review_note", schema: reviewNoteSchema, budget: new RunBudget({ maxCalls: 2, maxTokens: 100_000 }),
    timeoutMs: TIMEOUTS.review, signal
  });
  await deps.pool.query("UPDATE caphub_v2.capabilities SET review_note = $2, updated_at = now() WHERE id = $1", [capabilityId, JSON.stringify(note)]);
  return note;
}
```

- [ ] **Step 4: 运行确认通过** → 1 passed

- [ ] **Step 5: 提交**

```bash
git add lib/analysis/review.ts lib/analysis/review.test.ts && git commit -m "feat(analysis): manual second-opinion review via deepseek"
```

---

### Task 14: Web — Access JWT 校验、投递 API、最简投递页

**Files:**
- Create: `lib/auth/access.ts`, `lib/auth/access.test.ts`, `proxy.ts`（Next 16 的请求拦截文件；读 `node_modules/next/dist/docs/` 中关于 proxy/middleware 的指南确认文件名与导出签名）、`lib/runtime.ts`、`app/api/captures/route.ts`、`app/api/captures/route.test.ts`、`app/page.tsx`（替换）、`app/capture-form.tsx`
- 来源：`$ALLJOBS/components/caphub/capture-form.tsx`（拖拽/粘贴逻辑；去掉 v1 的 known-capture 轮询）

**Interfaces:**
- Consumes: `submitCapture`、`listRecentCaptures` (Task 5)、`loadConfig`
- Produces:
  - `verifyAccessJwt(token: string, opts: { aud: string; teamDomain: string; fetch?: typeof fetch; now?: () => Date }): Promise<{ email: string }>`（用 `jose` 的 `createRemoteJWKSet(https://<teamDomain>/cdn-cgi/access/certs)` + `jwtVerify`，校验 `aud`、`iss = https://<teamDomain>`）
  - `proxy.ts`：所有路径（除 `/_next/*`、`/favicon.ico`）读取 `Cf-Access-Jwt-Assertion` 头或 `CF_Authorization` cookie，无效返回 401 JSON；`NODE_ENV=development` 且设置 `ACCESS_BYPASS=1` 时放行（只用于本地）
  - `getRuntime(): { config; pool; objects }`（进程级单例）
  - `POST /api/captures`：`multipart/form-data`（`file` 或 `text`）→ `{ captureId, runId, duplicate }`；文件 > 10 MB 或非 png/jpeg/webp → 400；纯 URL 文本按 url 处理
  - `GET /api/captures` → `{ items: RecentCapture[] }`

- [ ] **Step 1: 失败测试**

`lib/auth/access.test.ts`（用 `jose` 现场生成密钥对签一个 JWT，注入返回该 JWKS 的 fetch）:
```ts
import { describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { verifyAccessJwt } from "./access";

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const fetchFn = (async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const sign = (claims: Record<string, unknown>) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuedAt().setExpirationTime("1h").sign(privateKey);
  return { fetchFn, sign };
}

describe("verifyAccessJwt", () => {
  it("accepts a token with matching aud and iss", async () => {
    const { fetchFn, sign } = await setup();
    const token = await sign({ aud: "aud1", iss: "https://team.cloudflareaccess.com", email: "a@b.c" });
    expect(await verifyAccessJwt(token, { aud: "aud1", teamDomain: "team.cloudflareaccess.com", fetch: fetchFn })).toEqual({ email: "a@b.c" });
  });
  it("rejects wrong aud", async () => {
    const { fetchFn, sign } = await setup();
    const token = await sign({ aud: "other", iss: "https://team.cloudflareaccess.com", email: "a@b.c" });
    await expect(verifyAccessJwt(token, { aud: "aud1", teamDomain: "team.cloudflareaccess.com", fetch: fetchFn })).rejects.toThrow();
  });
});
```

`app/api/captures/route.test.ts`（把 handler 逻辑放在 `lib/api/captures.ts` 便于测试；route 文件只做转发）:
```ts
import { describe, expect, it } from "vitest";
import { handleCreateCapture } from "../../../lib/api/captures";

describe("handleCreateCapture", () => {
  const submit = async (input: { kind: string }) => ({ captureId: "cap_1", runId: "run_1", duplicate: false, kind: input.kind });
  it("treats a bare https url as url kind", async () => {
    const form = new FormData(); form.set("text", "https://example.com/x");
    const res = await handleCreateCapture(new Request("http://l/api/captures", { method: "POST", body: form }), { submit: submit as never, maxUploadBytes: 10 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ captureId: "cap_1", kind: "url" });
  });
  it("rejects oversize file", async () => {
    const form = new FormData(); form.set("file", new File([new Uint8Array(11)], "a.png", { type: "image/png" }));
    const res = await handleCreateCapture(new Request("http://l/api/captures", { method: "POST", body: form }), { submit: submit as never, maxUploadBytes: 10 });
    expect(res.status).toBe(400);
  });
  it("rejects unsupported mime", async () => {
    const form = new FormData(); form.set("file", new File([new Uint8Array(1)], "a.gif", { type: "image/gif" }));
    const res = await handleCreateCapture(new Request("http://l/api/captures", { method: "POST", body: form }), { submit: submit as never, maxUploadBytes: 10 });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 实现**

`lib/auth/access.ts`:
```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifyAccessJwt(
  token: string,
  opts: { aud: string; teamDomain: string; fetch?: typeof fetch; now?: () => Date }
): Promise<{ email: string }> {
  const issuer = `https://${opts.teamDomain}`;
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), opts.fetch ? { [Symbol.for("jose.fetch")]: opts.fetch } as never : undefined);
    if (!opts.fetch) jwksCache.set(issuer, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, { audience: opts.aud, issuer, currentDate: opts.now?.() });
  const email = typeof payload.email === "string" ? payload.email : "";
  if (!email) throw new Error("ACCESS_EMAIL_MISSING");
  return { email };
}
```
如果 `jose` 版本不支持通过 options 注入 fetch，改用 `createLocalJWKSet` + 自行 `fetch` JWKS 并缓存 10 分钟，测试注入的 fetch 走同一路径。

`proxy.ts`（Next 16；若该版本文档指明文件名为 `middleware.ts`，按文档）:
```ts
import { NextResponse, type NextRequest } from "next/server";
import { verifyAccessJwt } from "./lib/auth/access";

export const config = { matcher: ["/((?!_next/|favicon.ico).*)"] };

export async function proxy(request: NextRequest) {
  if (process.env.NODE_ENV === "development" && process.env.ACCESS_BYPASS === "1") return NextResponse.next();
  const token = request.headers.get("cf-access-jwt-assertion") ?? request.cookies.get("CF_Authorization")?.value;
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    await verifyAccessJwt(token, { aud: process.env.CF_ACCESS_AUD!, teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN! });
    return NextResponse.next();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}
```

`lib/runtime.ts`:
```ts
import "server-only";
import { loadConfig, type Config } from "./config";
import { createPool } from "./db/pool";
import { createObjectStore, type ObjectStore } from "./storage/s3";
import type { Pool } from "pg";

let runtime: { config: Config; pool: Pool; objects: ObjectStore } | undefined;
export function getRuntime() {
  if (!runtime) {
    const config = loadConfig();
    runtime = { config, pool: createPool(config.databaseUrl), objects: createObjectStore(config.s3) };
  }
  return runtime;
}
```

`lib/api/captures.ts`:
```ts
import type { CaptureInput } from "../captures/dedupe";
import type { SubmitResult } from "../captures/captures";
import type { ImageMime } from "../storage/s3";

const MIMES = new Set<ImageMime>(["image/png", "image/jpeg", "image/webp"]);

export async function handleCreateCapture(
  request: Request,
  deps: { submit(input: CaptureInput): Promise<SubmitResult>; maxUploadBytes: number }
): Promise<Response> {
  let form: FormData;
  try { form = await request.formData(); } catch { return Response.json({ error: "invalid form" }, { status: 400 }); }
  const file = form.get("file");
  const text = form.get("text");
  let input: CaptureInput;
  if (file instanceof File && file.size > 0) {
    if (!MIMES.has(file.type as ImageMime)) return Response.json({ error: "unsupported image type" }, { status: 400 });
    if (file.size > deps.maxUploadBytes) return Response.json({ error: "file too large" }, { status: 400 });
    input = { source: "web", kind: "image", bytes: new Uint8Array(await file.arrayBuffer()), mimeType: file.type as ImageMime };
  } else if (typeof text === "string" && text.trim()) {
    const t = text.trim();
    input = /^https:\/\/\S+$/.test(t) ? { source: "web", kind: "url", url: t } : { source: "web", kind: "text", text: t };
  } else {
    return Response.json({ error: "file or text required" }, { status: 400 });
  }
  try {
    const result = await deps.submit(input);
    return Response.json({ ...result, kind: input.kind });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "submit failed" }, { status: 400 });
  }
}
```

`app/api/captures/route.ts`:
```ts
import { handleCreateCapture } from "../../../lib/api/captures";
import { listRecentCaptures, submitCapture } from "../../../lib/captures/captures";
import { getRuntime } from "../../../lib/runtime";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request) {
  const { pool, objects, config } = getRuntime();
  return handleCreateCapture(request, { submit: (input) => submitCapture({ pool, objects, pipeline: config.pipeline }, input), maxUploadBytes: MAX_UPLOAD_BYTES });
}

export async function GET() {
  const { pool } = getRuntime();
  return Response.json({ items: await listRecentCaptures(pool) });
}
```

`app/capture-form.tsx`（client 组件）：一个 `<textarea>` + 拖拽区 + 粘贴监听（`onPaste` 取 `clipboardData.files[0]` 或文本），提交到 `/api/captures`，成功后调用 `router.refresh()`。从 `$ALLJOBS/components/caphub/capture-form.tsx` 复制拖拽与粘贴处理函数，删除 known-capture 逻辑。

`app/page.tsx`（server 组件）：
```tsx
import { listRecentCaptures } from "../lib/captures/captures";
import { getRuntime } from "../lib/runtime";
import { CaptureForm } from "./capture-form";

export const dynamic = "force-dynamic";

const LABEL: Record<string, string> = { queued: "排队中", running: "分析中", done: "已建卡", failed: "失败" };

export default async function Page() {
  const items = await listRecentCaptures(getRuntime().pool);
  return (
    <main>
      <h1>投递</h1>
      <CaptureForm />
      <h2>最近 20 条</h2>
      <ul>
        {items.map((c) => (
          <li key={c.id}>
            <code>{c.id}</code> · {c.kind} · {c.runState ? LABEL[c.runState] : "—"}
            {c.errorCode ? ` (${c.errorCode})` : ""}
            {c.capabilityId ? ` → ${c.capabilityId}` : ""}
          </li>
        ))}
      </ul>
    </main>
  );
}
```

- [ ] **Step 4: 运行确认通过** → `npx vitest run lib/auth lib/api app` 5 passed；`npm run build` 成功

- [ ] **Step 5: 本地手工冒烟**（`ACCESS_BYPASS=1 npm run dev` + 指向临时 Neon branch 与真实桶；不调模型：`ANALYSIS_ENABLED=false`）：粘贴一段文字 → 列表出现「排队中」；再粘贴同一段 → 返回 `duplicate: true`。

- [ ] **Step 6: 提交**

```bash
git add proxy.ts lib/auth lib/api lib/runtime.ts app && git commit -m "feat(web): access jwt guard, capture api and minimal submit page"
```

---

### Task 15: v1 旧数据导入命令

**Files:**
- Create: `scripts/import-v1.ts`, `lib/import/v1.ts`, `lib/import/v1.test.ts`

**Interfaces:**
- Consumes: `submitCapture`（source `"import"`）
- Produces: `importV1Captures(deps: { pool: Pool; objects: ObjectStore; pipeline: Pipeline }, opts: { dryRun: boolean }): Promise<Array<{ v1Id: string; captureId: string | null; duplicate: boolean; skipped?: string }>>`
- 读 v1：`SELECT r.record_id, v.payload FROM caphub.registry_records r JOIN caphub.registry_versions v ON v.record_id = r.record_id AND v.version = r.current_version WHERE r.kind = 'capture' ORDER BY r.created_at`；`payload.object.key` 是同一桶里的对象键，`payload.mime_type` 是 mime。**只读 v1，不写。**
- 图片字节：从 S3 `get` 读回（同桶），再走 `submitCapture`（它会 `putIfAbsent`——因为键相同，S3 不会重复写）。

- [ ] **Step 1: 失败测试**

`lib/import/v1.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { importV1Captures } from "./v1";

describe("importV1Captures", () => {
  it("submits each v1 capture as an image import and reports duplicates", async () => {
    const key = "sha256/aa/" + "a".repeat(64);
    const pool = { query: async (text: string) => text.includes("caphub.registry_records") ? { rows: [{ record_id: "cap_v1", payload: { object: { key }, mime_type: "image/png" } }] } : { rows: [] } } as never;
    const objects = { get: async () => new Uint8Array([1, 2, 3]) } as never;
    const submitted: unknown[] = [];
    const out = await importV1Captures({ pool, objects, pipeline: "minimax", submit: async (i: unknown) => { submitted.push(i); return { captureId: "cap_new", runId: "run_1", duplicate: false }; } } as never, { dryRun: false });
    expect(out).toEqual([{ v1Id: "cap_v1", captureId: "cap_new", duplicate: false }]);
    expect(submitted[0]).toMatchObject({ source: "import", kind: "image", mimeType: "image/png" });
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 实现**

`lib/import/v1.ts`:
```ts
import type { Pool } from "pg";
import type { Pipeline } from "../config";
import { submitCapture, type SubmitResult } from "../captures/captures";
import type { CaptureInput } from "../captures/dedupe";
import type { ImageMime, ObjectStore } from "../storage/s3";

interface V1Row { record_id: string; payload: { object?: { key?: string }; mime_type?: string } }

export async function importV1Captures(
  deps: { pool: Pool; objects: ObjectStore; pipeline: Pipeline; submit?: (input: CaptureInput) => Promise<SubmitResult> },
  opts: { dryRun: boolean }
): Promise<Array<{ v1Id: string; captureId: string | null; duplicate: boolean; skipped?: string }>> {
  const submit = deps.submit ?? ((input: CaptureInput) => submitCapture({ pool: deps.pool, objects: deps.objects, pipeline: deps.pipeline }, input));
  const rows = (await deps.pool.query<V1Row>(
    `SELECT r.record_id, v.payload FROM caphub.registry_records r
     JOIN caphub.registry_versions v ON v.record_id = r.record_id AND v.version = r.current_version
     WHERE r.kind = 'capture' ORDER BY r.created_at`)).rows;
  const out = [];
  for (const row of rows) {
    const key = row.payload.object?.key;
    const mime = row.payload.mime_type as ImageMime | undefined;
    if (!key || !mime || !["image/png", "image/jpeg", "image/webp"].includes(mime)) { out.push({ v1Id: row.record_id, captureId: null, duplicate: false, skipped: "no image object" }); continue; }
    if (opts.dryRun) { out.push({ v1Id: row.record_id, captureId: null, duplicate: false, skipped: "dry-run" }); continue; }
    let bytes: Uint8Array;
    try { bytes = await deps.objects.get({ key, digest: key.split("/")[2], bytes: 0 }); }
    catch { out.push({ v1Id: row.record_id, captureId: null, duplicate: false, skipped: "object unreadable" }); continue; }
    const r = await submit({ source: "import", kind: "image", bytes, mimeType: mime });
    out.push({ v1Id: row.record_id, captureId: r.captureId, duplicate: r.duplicate });
  }
  return out;
}
```

`scripts/import-v1.ts`:
```ts
import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { createObjectStore } from "../lib/storage/s3";
import { importV1Captures } from "../lib/import/v1";

const dryRun = !process.argv.includes("--apply");
const config = loadConfig();
const pool = createPool(config.databaseUrl);
importV1Captures({ pool, objects: createObjectStore(config.s3), pipeline: config.pipeline }, { dryRun })
  .then((r) => { console.log(JSON.stringify({ dryRun, imported: r }, null, 2)); return pool.end(); })
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; return pool.end(); });
```

- [ ] **Step 4: 运行确认通过** → 1 passed

- [ ] **Step 5: 提交**

```bash
git add lib/import scripts/import-v1.ts && git commit -m "feat(import): one-shot import of v1 captures into caphub_v2"
```

---

### Task 16: Railway 部署（web + worker）与 Neon 正式 schema

**Files:**
- Create: `Dockerfile.web`, `Dockerfile.worker`, `railway.json`, `docs/deploy.md`

**Interfaces:**
- Produces: Railway project `caphub`，两个 service：`web`（Dockerfile.web，暴露 `PORT`）、`worker`（Dockerfile.worker，无端口，`npm run worker -- --daemon`）。

- [ ] **Step 1: Dockerfile**

`Dockerfile.web`:
```dockerfile
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/app ./app
COPY --from=build /app/lib ./lib
COPY --from=build /app/proxy.ts ./proxy.ts
CMD ["npm", "run", "start"]
```

`Dockerfile.worker`:
```dockerfile
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci
COPY lib ./lib
COPY scripts ./scripts
COPY tsconfig.json ./
CMD ["npx", "tsx", "scripts/worker.ts", "--daemon"]
```

`railway.json`:
```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "Dockerfile.web" },
  "deploy": { "restartPolicyType": "ON_FAILURE", "restartPolicyMaxRetries": 5 }
}
```
worker service 在 Railway 面板里把 Dockerfile 路径覆盖为 `Dockerfile.worker`（或用 `RAILWAY_DOCKERFILE_PATH` 变量）。两个 service 都设 replicas = 1；`web` 开启 Railway 的 app sleeping（若套餐支持）。

- [ ] **Step 2: 本地构建镜像验证**

Run: `docker build -f Dockerfile.web -t caphub-web . && docker build -f Dockerfile.worker -t caphub-worker .`
Expected: 两个镜像构建成功。`docker run --rm caphub-worker npx tsx scripts/worker.ts --dry-run` 在缺 env 时应打印配置错误并非崩溃栈。

- [ ] **Step 3: Neon 正式 schema 与角色**（需 Human 授权；对主 branch 的写操作）

在 Neon project `caphub` 主 branch：
```sql
-- 由 npm run migrate 用 owner 连接串执行 001（建 caphub_v2）。然后：
CREATE ROLE caphub_v2_app LOGIN PASSWORD '<由 Neon 生成，不写入仓库>';
GRANT USAGE ON SCHEMA caphub_v2 TO caphub_v2_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA caphub_v2 TO caphub_v2_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA caphub_v2 TO caphub_v2_app;
GRANT USAGE ON SCHEMA caphub TO caphub_v2_app;                -- 导入 v1 需要只读
GRANT SELECT ON ALL TABLES IN SCHEMA caphub TO caphub_v2_app;
```
`DATABASE_URL` 用 `caphub_v2_app`；迁移只由 Human 本地用 owner 串跑 `npm run migrate`，Railway 上不放 owner 串。

> **已完成（2026-09-19）**：Railway project `Caphub` 已建，id `fd170595-5a8f-4579-b09c-cb08894b3c19`，环境 `production` = `8f95c499-edcb-4725-bc86-bb9132d61d78`。Railway 区域按 service 设置：建 `web`、`worker` 时都选 **Singapore（Asia Southeast）**，建好后用 `describe-environment` 核对。Linear：AGE-276…AGE-293 对应 Task 1…18。

- [ ] **Step 4: 在已建的 Railway project 里建两个 service 并部署**（需 Human 授权；用 Railway MCP `create-project` / `create-service` / `set-variables` / `create-deployment`；密钥值由 Human 在面板粘贴或通过 MCP 由 Human 提供，不出现在对话记录里）

变量清单即 `.env.example`；`PIPELINE=minimax`、`ANALYSIS_ENABLED=false`（先关，spike 时再开）、`RETENTION_ENABLED=true`、`TELEGRAM_ENABLED=false`。

- [ ] **Step 5: 冒烟**

- `web` 的 Railway 域名：无 JWT 访问 `/` → 401；带一个由 Cloudflare Access 颁发的 JWT（Human 先把 `caphub.agentjoey.ai` 挂上 Access 并登录一次拿 cookie）→ 200 投递页。
- `worker` 日志出现 `{"tick":"disabled"}` 以外的正常 tick 或 idle（`ANALYSIS_ENABLED=false` 时无 tick 日志，只有 retention "nothing due"）。

- [ ] **Step 6: 写 `docs/deploy.md`**：服务表、变量表（只有名字）、迁移流程（本地 owner 串）、回滚（Railway redeploy 上一版本）、成本设置（replicas 1、sleeping）。

- [ ] **Step 7: 提交**

```bash
git add Dockerfile.web Dockerfile.worker railway.json docs/deploy.md && git commit -m "chore(deploy): railway web and worker images" && git push
```

---

### Task 17: A/B spike

**Files:**
- Create: `scripts/spike.ts`, `lib/spike/report.ts`, `lib/spike/report.test.ts`, `docs/spike-2026-09.md`（结果）

**Interfaces:**
- Produces:
  - `enqueueSpikeRuns(pool, pipelines: Pipeline[]): Promise<number>`（对每条 `source='import'` 的 capture、每条管线各插一条 `queued` run；已存在同 pipeline 且 `done` 的跳过）
  - `buildSpikeReport(pool): Promise<SpikeReport>`；`type SpikeReport = { byPipeline: Record<Pipeline, { runs: number; done: number; failed: number; avgDurationMs: number; avgTokens: number; stepAvg: Record<StepName, { durationMs: number; tokens: number }> }>; cards: Array<{ captureId; pipeline; title; type; suggested_verdict; confidence; tags }> }`
  - `renderSpikeMarkdown(report: SpikeReport): string`
- 先决条件（**每项需 Human 明确授权**）：Task 16 已部署；`TAVILY_API_KEY` 已放入 Railway；`ANALYSIS_ENABLED=true`；`import:v1 --apply` 已执行（14 条）。

- [ ] **Step 1: 失败测试**

`lib/spike/report.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { renderSpikeMarkdown } from "./report";

describe("renderSpikeMarkdown", () => {
  it("renders a per-pipeline table and card list", () => {
    const md = renderSpikeMarkdown({
      byPipeline: { minimax: { runs: 2, done: 2, failed: 0, avgDurationMs: 12000, avgTokens: 9000, stepAvg: { vision: { durationMs: 4000, tokens: 3000 }, search: { durationMs: 5000, tokens: 5000 }, reason: { durationMs: 3000, tokens: 1000 }, review: { durationMs: 0, tokens: 0 } } },
                    mixed: { runs: 2, done: 1, failed: 1, avgDurationMs: 8000, avgTokens: 4000, stepAvg: { vision: { durationMs: 4000, tokens: 3000 }, search: { durationMs: 1500, tokens: 0 }, reason: { durationMs: 2500, tokens: 1000 }, review: { durationMs: 0, tokens: 0 } } } },
      cards: [{ captureId: "cap_1", pipeline: "minimax", title: "t", type: "skill", suggested_verdict: "keep", confidence: 0.9, tags: ["a"] }]
    });
    expect(md).toContain("| minimax | 2 | 2 | 0 | 12.0 s | 9000 |");
    expect(md).toContain("cap_1");
  });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL

- [ ] **Step 3: 实现**

`lib/spike/report.ts`:
```ts
import type { Pool } from "pg";
import type { Pipeline } from "../config";
import { newId } from "../ids";
import type { StepName } from "../analysis/steps";

export interface SpikeReport {
  byPipeline: Record<Pipeline, { runs: number; done: number; failed: number; avgDurationMs: number; avgTokens: number; stepAvg: Record<StepName, { durationMs: number; tokens: number }> }>;
  cards: Array<{ captureId: string; pipeline: Pipeline; title: string; type: string; suggested_verdict: string; confidence: number; tags: string[] }>;
}

export async function enqueueSpikeRuns(pool: Pick<Pool, "query">, pipelines: Pipeline[]): Promise<number> {
  let n = 0;
  for (const pipeline of pipelines) {
    const r = await pool.query(
      `INSERT INTO caphub_v2.analysis_runs (id, capture_id, pipeline, state)
       SELECT $1 || substr(md5(c.id || $2), 1, 12), c.id, $2, 'queued' FROM caphub_v2.captures c
       WHERE c.source = 'import' AND NOT EXISTS (SELECT 1 FROM caphub_v2.analysis_runs r WHERE r.capture_id = c.id AND r.pipeline = $2 AND r.state IN ('queued','running','done'))`,
      [newId("run").slice(0, 4), pipeline]);
    n += r.rowCount ?? 0;
  }
  return n;
}

export async function buildSpikeReport(pool: Pick<Pool, "query">): Promise<SpikeReport> {
  const runs = (await pool.query<{ pipeline: Pipeline; runs: string; done: string; failed: string; avg_ms: string | null }>(
    `SELECT pipeline, count(*)::text AS runs, count(*) FILTER (WHERE state='done')::text AS done, count(*) FILTER (WHERE state='failed')::text AS failed,
            avg(extract(epoch FROM (finished_at - started_at)) * 1000) FILTER (WHERE state='done')::text AS avg_ms
     FROM caphub_v2.analysis_runs r JOIN caphub_v2.captures c ON c.id = r.capture_id WHERE c.source='import' GROUP BY pipeline`)).rows;
  const steps = (await pool.query<{ pipeline: Pipeline; step: StepName; avg_ms: string; avg_tokens: string; per_run_tokens: string }>(
    `SELECT r.pipeline, s.step, avg(s.duration_ms)::text AS avg_ms, avg(coalesce(s.input_tokens,0)+coalesce(s.output_tokens,0))::text AS avg_tokens,
            (sum(coalesce(s.input_tokens,0)+coalesce(s.output_tokens,0)) / greatest(count(DISTINCT r.id),1))::text AS per_run_tokens
     FROM caphub_v2.analysis_steps s JOIN caphub_v2.analysis_runs r ON r.id = s.run_id JOIN caphub_v2.captures c ON c.id = r.capture_id
     WHERE c.source='import' AND s.ok GROUP BY r.pipeline, s.step`)).rows;
  const cards = (await pool.query<SpikeReport["cards"][number]>(
    `SELECT cb.capture_id AS "captureId", r.pipeline, cb.title, cb.type, cb.suggested_verdict, cb.confidence, cb.tags
     FROM caphub_v2.capabilities cb JOIN caphub_v2.analysis_runs r ON r.id = cb.run_id ORDER BY cb.capture_id, r.pipeline`)).rows;
  const empty = () => ({ runs: 0, done: 0, failed: 0, avgDurationMs: 0, avgTokens: 0, stepAvg: { vision: { durationMs: 0, tokens: 0 }, search: { durationMs: 0, tokens: 0 }, reason: { durationMs: 0, tokens: 0 }, review: { durationMs: 0, tokens: 0 } } });
  const byPipeline: SpikeReport["byPipeline"] = { minimax: empty(), mixed: empty() };
  for (const r of runs) byPipeline[r.pipeline] = { ...byPipeline[r.pipeline], runs: +r.runs, done: +r.done, failed: +r.failed, avgDurationMs: Math.round(+(r.avg_ms ?? 0)) };
  for (const s of steps) {
    byPipeline[s.pipeline].stepAvg[s.step] = { durationMs: Math.round(+s.avg_ms), tokens: Math.round(+s.avg_tokens) };
    byPipeline[s.pipeline].avgTokens += Math.round(+s.per_run_tokens);
  }
  return { byPipeline, cards };
}

export function renderSpikeMarkdown(r: SpikeReport): string {
  const lines = ["# A/B spike 结果", "", "| pipeline | runs | done | failed | 平均耗时 | 平均 tokens |", "|---|---|---|---|---|---|"];
  for (const p of ["minimax", "mixed"] as const) {
    const x = r.byPipeline[p];
    lines.push(`| ${p} | ${x.runs} | ${x.done} | ${x.failed} | ${(x.avgDurationMs / 1000).toFixed(1)} s | ${x.avgTokens} |`);
  }
  lines.push("", "## 分步平均", "", "| pipeline | step | 耗时 | tokens |", "|---|---|---|---|");
  for (const p of ["minimax", "mixed"] as const) for (const s of ["vision", "search", "reason"] as const) {
    lines.push(`| ${p} | ${s} | ${(r.byPipeline[p].stepAvg[s].durationMs / 1000).toFixed(1)} s | ${r.byPipeline[p].stepAvg[s].tokens} |`);
  }
  lines.push("", "## 卡片（供 Human 打分 1–5）", "", "| capture | pipeline | title | type | 建议 | conf | tags | 评分 |", "|---|---|---|---|---|---|---|---|");
  for (const c of r.cards) lines.push(`| ${c.captureId} | ${c.pipeline} | ${c.title} | ${c.type} | ${c.suggested_verdict} | ${c.confidence.toFixed(2)} | ${c.tags.join(", ")} |  |`);
  return lines.join("\n");
}
```

`scripts/spike.ts`:
```ts
import { writeFile } from "node:fs/promises";
import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { buildSpikeReport, enqueueSpikeRuns, renderSpikeMarkdown } from "../lib/spike/report";

const cmd = process.argv[2];
const pool = createPool(loadConfig().databaseUrl);
(async () => {
  if (cmd === "enqueue") console.log(JSON.stringify({ enqueued: await enqueueSpikeRuns(pool, ["minimax", "mixed"]) }));
  else if (cmd === "report") { const md = renderSpikeMarkdown(await buildSpikeReport(pool)); await writeFile("docs/spike-2026-09.md", md); console.log(md); }
  else throw new Error("usage: spike enqueue|report");
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => pool.end());
```

注意：worker 用 `config.pipeline` 建 deps，但 spike 的 run 行自带 `pipeline` 列。修改 Task 12 的 `scripts/worker.ts`：为两条管线各建一份 deps（`mixed` 仅当 `tavilyApiKey` 存在），`run: (lease, signal) => runPipeline(depsFor[lease.pipeline], lease, signal)`；缺 key 的管线 lease 直接 finish `failed / PIPELINE_UNAVAILABLE`。

- [ ] **Step 4: 运行确认通过** → 1 passed；typecheck 通过

- [ ] **Step 5: 执行 spike**（逐步授权）

1. Human 确认：真实模型调用授权、Tavily key 已入 Railway、`ANALYSIS_ENABLED=true`。
2. 本地用 app 连接串：`npm run import:v1 -- --apply`（期望 14 条，重复为 0）。
3. `npx tsx scripts/spike.ts enqueue`（期望 28 条 run；worker 一次一个，单条上限约 4 分钟，全部跑完预计 ≤ 1 小时）。
4. 用 `npm run worker -- --dry-run` 观察队列直到 `queued/running` 为 0。
5. `npx tsx scripts/spike.ts report` → `docs/spike-2026-09.md`；Human 在评分列打分。
6. 若某管线 failed > 3 条，先看 `analysis_steps.error` 分布，修 adapter 后 `requeue` 失败的 run 再跑一次；不得为通过而放宽 schema。

- [ ] **Step 6: 定型**

Human 依据耗时、tokens、评分选定 `PIPELINE`；在 Railway 设值；在 `docs/spike-2026-09.md` 末尾记录决定与理由。

- [ ] **Step 7: 提交**

```bash
git add lib/spike scripts/spike.ts scripts/worker.ts docs/spike-2026-09.md && git commit -m "feat(spike): A/B pipeline benchmark and report" && git push
```

---

### Task 18: 文档收尾与 alljobs 侧记录

**Files:**
- Create（caphub 仓库）: `docs/superpowers/specs/2026-09-19-caphub-v2-design.md`（从 alljobs 复制）、`docs/superpowers/plans/2026-09-19-caphub-v2-foundation.md`（本文件）
- Modify（alljobs 仓库）: `.agent/CURRENT.md`（在 "Current state" 里加一行：Caphub v2 仓库位置、Railway project、spike 结论、alljobs 内旧 Caphub 仍在线直到子项目 4）

- [ ] **Step 1: 复制 spec 与 plan 到新仓库并提交**

```bash
cd ~/AgentWorks/CodeSpace/Caphub && mkdir -p docs/superpowers/specs docs/superpowers/plans
cp $ALLJOBS/docs/superpowers/specs/2026-09-19-caphub-v2-design.md docs/superpowers/specs/
cp $ALLJOBS/docs/superpowers/plans/2026-09-19-caphub-v2-foundation.md docs/superpowers/plans/
git add docs && git commit -m "docs: carry v2 spec and foundation plan" && git push
```

- [ ] **Step 2: 更新 alljobs `.agent/CURRENT.md`**，只加一小段（不动其他内容），单独提交推送：

```
### Caphub v2（2026-09-xx）
- 仓库 ~/AgentWorks/CodeSpace/Caphub · github agentjoey/caphub · Railway project caphub（web + worker）
- Neon schema caphub_v2 已建；v1 schema 只读保留到子项目 4
- spike 结论：PIPELINE=<minimax|mixed>，见 caphub 仓库 docs/spike-2026-09.md
- alljobs 内旧 Caphub 路由与 worker 仍在线；子项目 4 才下线
```

- [ ] **Step 3: 全量检查**

Run（caphub 仓库）: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: 全绿。

---

## Self-review

**Spec coverage（§3–§5、§9.1 行 1、§9.2、§9.3、§10）**
- §3.1 仓库 → Task 1、18；§3.2 两服务 → Task 12、14、16；§3.3 数据 → Task 3、4；§3.4 鉴权（Access JWT、Telegram chat id）→ Task 14（Telegram 在子项目 3）；§3.5 配置 → Task 2；§3.6 成本 → Task 16 Step 1/6；§3.7 vault-sync → 子项目 4，不在本计划。
- §4 六张表 → Task 3；乐观锁 `updated_at` 的**使用**在子项目 2（决定动作），本计划只建列。
- §5.1 接口 → Task 7；§5.2 素材 → Task 10；§5.3 序列与 A/B → Task 9、11；§5.4 复核 → Task 13；§5.5 裁决 → Task 11；§5.6 预算/超时/失败/重跑（`requeue`）→ Task 6、7、11、12。
- §9.2 导入 → Task 15；§9.3 spike → Task 17；§9.1 行 1 验收（spike 定型、每步耗时记录）→ Task 7 的 `analysis_steps.duration_ms` + Task 17。
- §10 沿用：队列/租约（6）、去重（5）、S3（4）、适配器与结构化层（7、9）、预处理（10）、保留期（12）；丢弃项不复制。
- 缺口：spec §5.6「失败 run 在 web 显示原因，可手动重跑」——本计划的投递页只显示 `errorCode`，重跑按钮在子项目 2；`RunQueue.requeue` 已备好。

**Placeholder scan**：无 TBD/TODO；Task 14 的 `capture-form.tsx` 与 `globals.css` 是「从 v1 复制并删减」指令，来源路径与删减项已写明。

**Type consistency**：`Lease` 字段 `runId/captureId/pipeline/ownerToken` 在 Task 6、11、12 一致；`StructuredCall.invoke(input, signal)` 在 Task 7、9、11、13 一致；`SearchCall.search(query, signal)` 在 Task 9、11 一致；`ObjectRef.bytes` 允许 0 的改动在 Task 11 明示并回写 Task 4；`recordStep` 的 `StepRow` 在 Task 7、11、12 一致；`SubmitResult` 在 Task 5、14、15 一致。
