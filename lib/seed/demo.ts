import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { cardSchema, type Card } from "../analysis/card";
import { bumpTags } from "../analysis/tags";
import { jsonStringifyStripNul } from "../text/sanitize";

/**
 * Fixed-id demo dataset for manual verification on a temporary Neon branch (Task 10).
 * Every id is a stable `demo_...` literal (not `newId()`) so re-running the seed is a
 * no-op: every insert uses `ON CONFLICT ... DO NOTHING`.
 */

export interface DemoCaptureRow {
  id: string;
  source: "web";
  kind: "text" | "url";
  text: string | null;
  url: string | null;
  dedupeKey: string;
}

export interface DemoRunRow {
  id: string;
  captureId: string;
  pipeline: "minimax_tavily";
}

export interface DemoSource { title: string; url: string; content: string }

export interface DemoStepRow {
  runId: string;
  step: "vision" | "search" | "reason";
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  output: unknown;
}

export interface DemoCapabilityRow {
  id: string;
  captureId: string;
  runId: string;
  card: Card;
  verdict: "keep" | "discard" | "pending";
  verdictBy: "human" | null;
}

export interface DemoData {
  captures: DemoCaptureRow[];
  runs: DemoRunRow[];
  steps: DemoStepRow[];
  capabilities: DemoCapabilityRow[];
}

interface DemoSpec {
  n: number;
  kind: "text" | "url";
  text?: string;
  url?: string;
  card: Card;
  verdict: "keep" | "discard" | "pending";
  verdictBy: "human" | null;
  searchSources: DemoSource[];
}

const SPECS: DemoSpec[] = [
  {
    n: 1,
    kind: "url",
    url: "https://github.com/D4Vinci/Scrapling",
    verdict: "keep",
    verdictBy: "human",
    searchSources: [
      { title: "Scrapling: Undetectable, Lightning-Fast Web Scraping", url: "https://github.com/D4Vinci/Scrapling", content: "Scrapling adapts to website structure changes and avoids common anti-bot detection." },
      { title: "Scrapling vs. Playwright for scraping", url: "https://example.com/scrapling-vs-playwright", content: "Comparison of setup time, selector stability and anti-bot bypass rate." }
    ],
    card: {
      title: "Scrapling 自适应反爬抓取库",
      type: "skill",
      summary: "一个 Python 网页抓取库，通过学习页面结构自动适配 selector 变化，支持无头浏览器抓取和反爬绕过，可直接集成到数据采集流水线。",
      signals: ["GitHub 星标增长快", "文档给出可复制的 pip 安装命令"],
      suggested_verdict: "keep",
      suggested_reason: "有明确安装步骤且直接解决抓取稳定性问题，值得集成。",
      confidence: 0.86,
      usage: "integrate",
      playbook: { kind: "integrate", install: ["pip install scrapling"], repo: "https://github.com/D4Vinci/Scrapling", prompt_text: null },
      tags: ["web-scraping", "python", "anti-bot"],
      source_url: "https://github.com/D4Vinci/Scrapling"
    }
  },
  {
    n: 2,
    kind: "text",
    text: "复现步骤：打开两个 Review 页标签，对同一张卡分别点『保留』，第二次提交显示成功但库里没变化。",
    verdict: "keep",
    verdictBy: "human",
    searchSources: [],
    card: {
      title: "Next.js 16 乐观锁并发冲突排障记录",
      type: "experience",
      summary: "记录一次 Server Action 并发写入引发的乐观锁冲突排查过程，以及最终采用 updated_at 比对解决的方案。",
      signals: ["两个标签页同时提交触发了看似随机的失败", "错误信息未直接指向 updated_at 冲突"],
      suggested_verdict: "keep",
      suggested_reason: "排障路径可复用，下次遇到类似冲突能直接定位。",
      confidence: 0.78,
      usage: "reference",
      playbook: {
        kind: "experience",
        content: "在 Review 页面对同一张卡开两个标签页分别点『保留』，第二次提交返回 200 但库里数据没变化，一开始以为是事务没提交。加日志后发现 Server Action 里用 UPDATE ... WHERE id = $1 AND updated_at = $2 做乐观锁，第二次请求的 updated_at 已经是旧值，UPDATE 影响行数为 0，被判定为『已在别处处理』。教训：before/after 的 updated_at 一定要在 UI 拿到最新值后再提交，不能缓存太久；同时要把『0 行受影响』和真正的 SQL 错误区分开，分别返回不同的 ActionResult，不然前端没法提示用户刷新。",
        when_to_use: "遇到并发编辑冲突或乐观锁更新没有生效时"
      },
      tags: ["nextjs", "optimistic-locking", "debugging"],
      source_url: null
    }
  },
  {
    n: 3,
    kind: "url",
    url: "https://github.com/tavily-ai/tavily-mcp",
    verdict: "keep",
    verdictBy: "human",
    searchSources: [],
    card: {
      title: "Tavily MCP 插件接入搜索能力",
      type: "plugin",
      summary: "官方 Tavily MCP Server，为 Agent 提供网页搜索工具调用，安装后可在对话中直接触发实时搜索并返回来源列表。",
      signals: ["提供标准 MCP 配置示例", "返回结果自带来源 URL"],
      suggested_verdict: "keep",
      suggested_reason: "补齐当前流水线缺少的实时检索能力。",
      confidence: 0.81,
      usage: "integrate",
      playbook: { kind: "integrate", install: ["npm install -g tavily-mcp"], repo: "https://github.com/tavily-ai/tavily-mcp", prompt_text: null },
      tags: ["mcp", "search", "tavily"],
      source_url: "https://github.com/tavily-ai/tavily-mcp"
    }
  },
  {
    n: 4,
    kind: "text",
    text: "你是一个信息整理助手。给定多篇来源文本，输出：1) 一句话标题；2) 3-5 条要点，每条标注对应来源编号；3) 若来源之间有冲突，单独列出。",
    verdict: "pending",
    verdictBy: null,
    searchSources: [],
    card: {
      title: "多来源摘要 Prompt 模板",
      type: "prompt",
      summary: "一段用于把多篇搜索结果压缩成结构化摘要的 prompt 模板，要求输出标题、要点和来源编号。",
      signals: ["明确要求输出来源编号，方便核对", "对输出长度有上限约束"],
      suggested_verdict: "keep",
      suggested_reason: "结构清晰可直接复用，但还未验证多语言场景。",
      confidence: 0.62,
      usage: "integrate",
      playbook: {
        kind: "integrate",
        install: [],
        repo: null,
        prompt_text: "你是一个信息整理助手。给定多篇来源文本，输出：1) 一句话标题；2) 3-5 条要点，每条标注对应来源编号；3) 若来源之间有冲突，单独列出。不要编造来源中没有的信息。"
      },
      tags: ["prompt-engineering", "summarization"],
      source_url: null
    }
  },
  {
    n: 5,
    kind: "url",
    url: "https://example.com/pg-fts-chinese-benchmark",
    verdict: "pending",
    verdictBy: null,
    searchSources: [],
    card: {
      title: "Postgres 全文检索中文分词方案对比",
      type: "other",
      summary: "一篇比较 zhparser、pg_jieba 与 simple 词典在 Postgres 全文检索中文效果的文章，附带索引大小和查询延迟数据。",
      signals: ["给出了具体基准测试数据", "作者未说明测试的 Postgres 版本"],
      suggested_verdict: "keep",
      suggested_reason: "内容对当前中文检索选型有参考价值，建议人工确认后再定。",
      confidence: 0.55,
      usage: "reference",
      playbook: {
        kind: "reference",
        points: [
          "zhparser 索引体积明显大于 simple 词典",
          "simple 词典对中文分词粒度较粗，但索引和查询都更快",
          "作者建议中文为主的场景仍先跑一遍基准再决定"
        ]
      },
      tags: ["postgres", "full-text-search", "chinese-nlp"],
      source_url: "https://example.com/pg-fts-chinese-benchmark"
    }
  },
  {
    n: 6,
    kind: "text",
    text: "javascript:(function(){html2canvas(document.body).then(function(c){c.toBlob(function(b){var a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='shot.png';a.click();});});})();",
    verdict: "discard",
    verdictBy: "human",
    searchSources: [],
    card: {
      title: "过时的 Chrome 手动截图书签脚本",
      type: "skill",
      summary: "一段通过浏览器书签栏 JS 手动触发截图并下载的脚本，功能已被 scripts/shot.mjs 的 Playwright 方案完全取代。",
      signals: ["依赖手动点击书签，无法自动化", "项目里已有等价能力覆盖"],
      suggested_verdict: "discard",
      suggested_reason: "功能被现有 Playwright 截图脚本完全覆盖，无需重复维护。",
      confidence: 0.91,
      usage: "reference",
      playbook: { kind: "reference", points: ["javascript: 书签脚本原理简单，靠 html2canvas 截图", "已被 scripts/shot.mjs 取代，无需保留"] },
      tags: ["screenshot", "legacy"],
      source_url: null
    }
  }
];

function dedupeKey(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

/** Pure builder: turns SPECS into the rows the seed script inserts. No I/O, fully deterministic. */
export function buildDemoRows(): DemoData {
  const captures: DemoCaptureRow[] = [];
  const runs: DemoRunRow[] = [];
  const steps: DemoStepRow[] = [];
  const capabilities: DemoCapabilityRow[] = [];

  for (const spec of SPECS) {
    const card = cardSchema.parse(spec.card);
    const captureId = `demo_cap_${spec.n}`;
    const runId = `demo_run_${spec.n}`;
    const capabilityId = `demo_cab_${spec.n}`;

    captures.push({
      id: captureId,
      source: "web",
      kind: spec.kind,
      text: spec.kind === "text" ? spec.text! : null,
      url: spec.kind === "url" ? spec.url! : null,
      dedupeKey: dedupeKey(captureId)
    });

    runs.push({ id: runId, captureId, pipeline: "minimax_tavily" });

    steps.push(
      { runId, step: "vision", provider: "minimax", model: "MiniMax-VL-2026", inputTokens: 512, outputTokens: 96, durationMs: 1400, output: { what: card.summary.slice(0, 40) } },
      { runId, step: "search", provider: "tavily", model: "tavily-search", inputTokens: 64, outputTokens: 0, durationMs: 900, output: { sources: spec.searchSources } },
      { runId, step: "reason", provider: "minimax", model: "MiniMax-Reason-2026", inputTokens: 1024, outputTokens: 256, durationMs: 2100, output: { card } }
    );

    capabilities.push({ id: capabilityId, captureId, runId, card, verdict: spec.verdict, verdictBy: spec.verdictBy });
  }

  return { captures, runs, steps, capabilities };
}

export function assertSeedAllowed(env: Readonly<Record<string, string | undefined>>): void {
  if (env.SEED_ALLOW !== "1") {
    throw new Error("Refusing to run: set SEED_ALLOW=1 to seed demo data into DATABASE_URL");
  }
}

/**
 * Inserts the demo dataset in one transaction, idempotently (every insert is
 * `ON CONFLICT ... DO NOTHING`, keyed by the fixed `demo_...` ids). Returns the ids of
 * capabilities actually created by *this* call (empty on a no-op re-run). Tag counts are
 * bumped only for capabilities this call newly created, so re-running never double-counts.
 */
export async function runSeedDemo(pool: Pick<Pool, "connect">, env: Readonly<Record<string, string | undefined>>): Promise<string[]> {
  assertSeedAllowed(env);
  const data = buildDemoRows();
  const client = (await pool.connect()) as PoolClient;
  const createdCapabilityIds: string[] = [];
  try {
    await client.query("BEGIN");

    for (const c of data.captures) {
      await client.query(
        `INSERT INTO caphub_v2.captures (id, source, kind, text, url, dedupe_key)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO NOTHING`,
        [c.id, c.source, c.kind, c.text, c.url, c.dedupeKey]
      );
    }

    for (const r of data.runs) {
      await client.query(
        `INSERT INTO caphub_v2.analysis_runs (id, capture_id, pipeline, state, attempts, started_at, finished_at)
         VALUES ($1,$2,$3,'done',1,now(),now())
         ON CONFLICT (id) DO NOTHING`,
        [r.id, r.captureId, r.pipeline]
      );
    }

    for (const s of data.steps) {
      await client.query(
        `INSERT INTO caphub_v2.analysis_steps (run_id, step, provider, model, attempt, input_tokens, output_tokens, duration_ms, ok, output)
         SELECT $1,$2,$3,$4,1,$5,$6,$7,true,$8::jsonb
         WHERE NOT EXISTS (SELECT 1 FROM caphub_v2.analysis_steps WHERE run_id = $1 AND step = $2)`,
        [s.runId, s.step, s.provider, s.model, s.inputTokens, s.outputTokens, s.durationMs, jsonStringifyStripNul(s.output)]
      );
    }

    for (const cap of data.capabilities) {
      const c = cap.card;
      const r = await client.query<{ id: string }>(
        `INSERT INTO caphub_v2.capabilities
           (id, capture_id, run_id, title, type, summary, signals, suggested_verdict, suggested_reason, confidence,
            verdict, verdict_by, verdict_at, usage, playbook, tags, source_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $12::text IS NULL THEN NULL ELSE now() END, $13,$14,$15,$16)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [cap.id, cap.captureId, cap.runId, c.title, c.type, c.summary, jsonStringifyStripNul(c.signals),
          c.suggested_verdict, c.suggested_reason, c.confidence, cap.verdict, cap.verdictBy, c.usage,
          jsonStringifyStripNul(c.playbook), c.tags, c.source_url]
      );
      if (r.rows.length) {
        createdCapabilityIds.push(r.rows[0].id);
        if (cap.verdict === "keep") await bumpTags(client, c.tags);
      }
    }

    await client.query("COMMIT");
    return createdCapabilityIds;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
