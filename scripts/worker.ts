import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { runPipeline } from "../lib/analysis/pipeline";
import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { createDeepSeekCall } from "../lib/providers/deepseek";
import { createGeminiEmbed } from "../lib/providers/gemini-embed";
import { purgeDeletedCapabilities, sweepRetention } from "../lib/retention/retention";
import { RunQueue } from "../lib/queue/runs";
import { createObjectStore } from "../lib/storage/s3";
import { runEmbedTick } from "../lib/worker/embeddings";
import { buildWorkerPipelines, selectPipelineDeps } from "../lib/worker/pipelines";
import { runReviewTick } from "../lib/worker/reviews";
import { runTick } from "../lib/worker/tick";

type Mode = "dry-run" | "once" | "daemon";

function parseArgs(args: string[]): Mode {
  const a = args[0] ?? "--dry-run";
  if (!["--dry-run", "--once", "--daemon"].includes(a)) throw new Error("usage: worker [--dry-run|--once|--daemon]");
  return a.slice(2) as Mode;
}

async function main() {
  const mode = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env, "worker");
  const pool = createPool(config.databaseUrl);
  const objects = createObjectStore(config.s3);
  const queue = new RunQueue(pool);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const log = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`);
  let retentionSweep: Promise<void> | undefined;
  try {
    if (mode === "dry-run") { log({ pipeline: config.pipeline, queue: await queue.summary() }); return; }
    const pipelines = buildWorkerPipelines(config, pool, objects);
    const reviewCall = createDeepSeekCall({ apiKey: config.providers.deepseekApiKey });
    const embedCall = config.providers.geminiApiKey ? createGeminiEmbed({ apiKey: config.providers.geminiApiKey }) : undefined;
    if (!config.analysisEnabled) log({ analysis: "disabled" });
    if (!embedCall) log({ embeddings: "disabled" });
    let nextRetention = 0;
    do {
      if (config.retentionEnabled && !retentionSweep && Date.now() >= nextRetention) {
        nextRetention = Date.now() + 3_600_000;
        retentionSweep = sweepRetention({ pool, objects }, { now: new Date(), dryRun: false })
          .then(async (r) => {
            log({ retention: r.length ? r : "nothing due" });
            const purged = await purgeDeletedCapabilities(pool, new Date());
            log({ purgedCapabilities: purged });
          })
          .catch((e) => { log({ retentionError: e instanceof Error ? e.message : String(e) }); })
          .finally(() => { retentionSweep = undefined; });
      }
      if (config.analysisEnabled) {
        try {
          const state = await runTick({
            queue,
            run: (lease, signal) => {
              const deps = selectPipelineDeps(pipelines, lease.pipeline);
              if (!deps) throw Object.assign(new Error(`no pipeline deps available for '${lease.pipeline}'`), { code: "PIPELINE_UNAVAILABLE" });
              return runPipeline(deps, lease, signal);
            },
            clock: () => new Date(),
            ownerToken: randomUUID,
            log
          }, controller.signal);
          if (state !== "idle") log({ tick: state });
          if (state === "idle") {
            let reviewState: "idle" | "processed" = "idle";
            try {
              reviewState = await runReviewTick({ pool, call: reviewCall, log }, controller.signal);
              if (reviewState !== "idle") log({ reviewTick: reviewState });
            } catch (e) {
              log({ reviewTickError: e instanceof Error ? e.message : String(e) });
            }
            if (reviewState === "idle" && embedCall) {
              try {
                const embedState = await runEmbedTick({ pool, embed: embedCall, log }, controller.signal);
                if (embedState !== "idle") log({ embedTick: embedState });
              } catch (e) {
                log({ embedTickError: e instanceof Error ? e.message : String(e) });
              }
            }
          }
        } catch (e) {
          log({ tickError: e instanceof Error ? e.message : String(e) });
          if (mode === "once") process.exitCode = 1;
        }
      }
      if (mode !== "daemon") break;
      await delay(2_000, undefined, { signal: controller.signal }).catch(() => {});
    } while (!controller.signal.aborted);
  } finally {
    await retentionSweep;
    await pool.end();
  }
}

main().catch((e) => { process.stderr.write(`worker failed: ${e instanceof Error ? e.message : e}\n`); process.exitCode = 1; });
