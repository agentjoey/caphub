import { writeFile } from "node:fs/promises";
import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { buildSpikeReport, enqueueSpikeRuns, parseEnqueuePipelines, renderSpikeMarkdown, spikePricesFromEnv } from "../lib/spike/report";

const cmd = process.argv[2];
const pool = createPool(loadConfig(process.env, "script").databaseUrl);

(async () => {
  if (cmd === "enqueue") {
    const pipelines = parseEnqueuePipelines(process.argv.slice(3));
    console.log(JSON.stringify({ enqueued: await enqueueSpikeRuns(pool, pipelines) }));
  } else if (cmd === "report") {
    const md = renderSpikeMarkdown(await buildSpikeReport(pool, spikePricesFromEnv(process.env)));
    await writeFile("docs/spike-2026-09.md", md);
    console.log(md);
  } else {
    throw new Error("usage: spike enqueue|report");
  }
})()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => pool.end());
