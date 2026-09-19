import { writeFile } from "node:fs/promises";
import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { buildSpikeReport, enqueueSpikeRuns, renderSpikeMarkdown } from "../lib/spike/report";

const cmd = process.argv[2];
const pool = createPool(loadConfig().databaseUrl);

(async () => {
  if (cmd === "enqueue") {
    console.log(JSON.stringify({ enqueued: await enqueueSpikeRuns(pool, ["minimax", "mixed"]) }));
  } else if (cmd === "report") {
    const md = renderSpikeMarkdown(await buildSpikeReport(pool));
    await writeFile("docs/spike-2026-09.md", md);
    console.log(md);
  } else {
    throw new Error("usage: spike enqueue|report");
  }
})()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => pool.end());
