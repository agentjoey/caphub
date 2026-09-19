import { loadConfig } from "../lib/config";
import { loadScenarios, scenariosPromptList, scenariosResultSchemaFor } from "../lib/analysis/scenarios";
import { createPool } from "../lib/db/pool";
import { createDeepSeekCall } from "../lib/providers/deepseek";

function parseArgs(args: string[]): { apply: boolean } {
  return { apply: args.includes("--apply") };
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env, "script");
  if (!config.providers.deepseekApiKey) throw new Error("DEEPSEEK_API_KEY required to backfill scenarios");
  const pool = createPool(config.databaseUrl);
  const call = createDeepSeekCall({ apiKey: config.providers.deepseekApiKey });
  const log = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`);
  try {
    const scenarios = await loadScenarios(pool);
    if (!scenarios.length) throw new Error("no scenarios configured in caphub_v2.scenarios; refusing to backfill");
    const slugs = scenarios.map((s) => s.slug) as [string, ...string[]];
    const resultSchema = scenariosResultSchemaFor(slugs);
    const scenarioList = scenariosPromptList(scenarios);

    // scenarios = '{}' is the DB default, so an untouched (never-classified) card still has
    // it; a card the pipeline or a prior backfill run already classified is skipped.
    const { rows } = await pool.query<{ id: string; title: string; summary: string; tags: string[] }>(
      `SELECT id, title, summary, tags FROM caphub_v2.capabilities
       WHERE deleted_at IS NULL AND scenarios = '{}'
       ORDER BY created_at`
    );
    log({ mode: apply ? "apply" : "dry-run", candidates: rows.length });
    let done = 0;
    let failed = 0;
    for (const row of rows) {
      const prompt = [
        "为下面这个个人 agent 能力库卡片，从候选应用场景中选出 1–3 个这个能力最可能被用在的应用场景，按贴切程度排列。",
        `标题：${row.title}`,
        `摘要：${row.summary}`,
        `标签：${row.tags.join(", ") || "（无）"}`,
        `候选应用场景（slug（中文名：关键词…））：${scenarioList}`,
        "只能用给出的 slug，不要自造。"
      ].join("\n\n");
      try {
        const raw = await call.invoke({ prompt, schemaName: "capability_scenarios", schema: resultSchema }, new AbortController().signal);
        const parsed = resultSchema.parse(raw.value);
        if (apply) {
          // Only the scenarios column is touched: this is a classification backfill, not a
          // re-analysis, so updated_at (and everything else the card contains) must not move.
          await pool.query("UPDATE caphub_v2.capabilities SET scenarios = $2 WHERE id = $1", [row.id, parsed.scenarios]);
        }
        log({ capabilityId: row.id, scenarios: parsed.scenarios, applied: apply });
        done += 1;
      } catch (error) {
        failed += 1;
        log({ capabilityId: row.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    log({ done, failed, mode: apply ? "apply" : "dry-run" });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`backfill-scenarios failed: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
