import { writeFile } from "node:fs/promises";
import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { buildSpikeReport, enqueueSpikeRuns, parseEnqueuePipelines, parseSpikeSource, renderSpikeMarkdown, spikePricesFromEnv } from "../lib/spike/report";

const cmd = process.argv[2];
const pool = createPool(loadConfig(process.env, "script").databaseUrl);

/** Pulls `--name value` out of args, returning the value (or undefined) and the remaining args. */
function extractOption(args: readonly string[], name: string): { value: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      value = args[++i];
    } else {
      rest.push(args[i]);
    }
  }
  return { value, rest };
}

(async () => {
  if (cmd === "enqueue") {
    const { value: sourceArg, rest } = extractOption(process.argv.slice(3), "--source");
    const source = parseSpikeSource(sourceArg);
    const pipelines = parseEnqueuePipelines(rest);
    console.log(JSON.stringify({ enqueued: await enqueueSpikeRuns(pool, pipelines, source) }));
  } else if (cmd === "report") {
    const { value: sourceArg, rest: afterSource } = extractOption(process.argv.slice(3), "--source");
    const { value: outArg } = extractOption(afterSource, "--out");
    const source = parseSpikeSource(sourceArg);
    const out = outArg ?? "docs/spike-2026-09.md";
    const md = renderSpikeMarkdown(await buildSpikeReport(pool, spikePricesFromEnv(process.env), source));
    await writeFile(out, md);
    console.log(md);
  } else {
    throw new Error("usage: spike enqueue|report [--source import|web|telegram|all] [--out <path>]");
  }
})()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => pool.end());
