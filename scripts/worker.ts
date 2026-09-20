import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { runPipeline } from "../lib/analysis/pipeline";
import { loadConfig, type WorkerConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { createDeepSeekCall } from "../lib/providers/deepseek";
import { createGeminiEmbed } from "../lib/providers/gemini-embed";
import { purgeDeletedCapabilities, sweepRetention } from "../lib/retention/retention";
import { RunQueue } from "../lib/queue/runs";
import { createObjectStore, type ObjectStore } from "../lib/storage/s3";
import { createTelegramApi, type TelegramApi } from "../lib/telegram/api";
import type { CaptureDeps } from "../lib/telegram/capture";
import { syncCommands } from "../lib/telegram/commands";
import type { HandleCallbackDeps } from "../lib/telegram/decide";
import { runTelegramTick, type TelegramLoopDeps } from "../lib/telegram/loop";
import { runNotifyTick, type NotifyTickDeps } from "../lib/telegram/notify";
import type { SearchDeps } from "../lib/telegram/search";
import { EmbedBackoff } from "../lib/worker/embed-backoff";
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

interface TelegramWiring {
  api: TelegramApi;
  loopDeps: TelegramLoopDeps;
  notifyDeps: NotifyTickDeps;
}

function buildTelegramWiring(config: WorkerConfig, pool: Pool, objects: ObjectStore, log: (o: Record<string, unknown>) => void): TelegramWiring {
  const api = createTelegramApi({ token: config.telegram.botToken! });
  const ownerChatId = Number(config.telegram.ownerChatId);
  const capture: CaptureDeps = { api, pool, objects, pipeline: config.pipeline };
  const search: SearchDeps = { pool, api, config };
  const callback: HandleCallbackDeps = { pool, api, ownerChatId, pipeline: config.pipeline, log };
  const loopDeps: TelegramLoopDeps = { pool, api, ownerChatId, capture, search, callback, log };
  const notifyDeps: NotifyTickDeps = { pool, api, ownerChatId, log };
  return { api, loopDeps, notifyDeps };
}

/**
 * A routine long-poll blip (a dropped connection, a 502, a single 429) must not make the bot
 * look dead for minutes — unlike the embed tick's provider-call backoff (5 min floor / 1 h cap,
 * appropriate for a paid API call worth throttling hard), Telegram polling backs off gently:
 * a 2 s floor and a 60 s cap, using the same `EmbedBackoff` class with its floor/cap overridden.
 */
const TELEGRAM_BACKOFF_INITIAL_MS = 2_000;
const TELEGRAM_BACKOFF_MAX_MS = 60_000;

/**
 * The Telegram long poll (`getUpdates`, up to a 25 s wait per call) and the notify push both run
 * here, on their own cadence, deliberately *outside* the main 2 s do/while loop below — serially
 * awaiting a 25 s poll inside that loop would starve the analysis/review/embed ticks (and the
 * retention sweep) for up to 25 s at a time. Each iteration's tick failures are caught and
 * backed off independently (mirroring the embed tick's `EmbedBackoff`, but with a much gentler
 * floor/cap — see {@link TELEGRAM_BACKOFF_INITIAL_MS}) so neither ever aborts this loop, and
 * every `await` here takes `signal` so a SIGTERM aborts an in-flight long poll immediately
 * instead of waiting out its timeout.
 *
 * While the poll is backed off, this sleeps out the *whole* remaining window in one `delay` (not
 * a fixed 2 s re-check) and skips the notify tick entirely for that window — a poll failure is
 * usually a shared network/Telegram-API problem, so retrying the notify push's two DB `SELECT`s
 * on every wake would just burn queries for a push that's also likely to fail. The skip is
 * logged once per window, not once per wake.
 */
async function runTelegramLoop(wiring: TelegramWiring, log: (o: Record<string, unknown>) => void, signal: AbortSignal): Promise<void> {
  const pollBackoff = new EmbedBackoff({ initialMs: TELEGRAM_BACKOFF_INITIAL_MS, maxMs: TELEGRAM_BACKOFF_MAX_MS });
  const notifyBackoff = new EmbedBackoff({ initialMs: TELEGRAM_BACKOFF_INITIAL_MS, maxMs: TELEGRAM_BACKOFF_MAX_MS });
  while (!signal.aborted) {
    if (pollBackoff.shouldSkip()) {
      const forMs = pollBackoff.remainingMs();
      log({ telegramTick: "skipped-backoff", forMs });
      await delay(forMs, undefined, { signal }).catch(() => {});
      continue;
    }
    try {
      const result = await runTelegramTick(wiring.loopDeps, signal);
      if (result.kind === "error") {
        log({ telegramTick: result });
        pollBackoff.onError(result.retryAfterMs);
      } else {
        if (result.kind === "processed") log({ telegramTick: result });
        pollBackoff.reset();
      }
    } catch (e) {
      log({ telegramTickError: e instanceof Error ? e.message : String(e) });
      pollBackoff.onError();
    }
    if (signal.aborted) break;
    if (notifyBackoff.shouldSkip()) {
      log({ notifyTick: "skipped-backoff", forMs: notifyBackoff.remainingMs() });
    } else {
      try {
        const state = await runNotifyTick(wiring.notifyDeps, signal);
        if (state === "error") {
          log({ notifyTick: state });
          notifyBackoff.onError();
        } else {
          if (state !== "idle") log({ notifyTick: state });
          notifyBackoff.reset();
        }
      } catch (e) {
        log({ notifyTickError: e instanceof Error ? e.message : String(e) });
        notifyBackoff.onError();
      }
    }
  }
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
  let telegramLoop: Promise<void> | undefined;
  try {
    if (mode === "dry-run") { log({ pipeline: config.pipeline, queue: await queue.summary() }); return; }
    const pipelines = buildWorkerPipelines(config, pool, objects);
    const reviewCall = createDeepSeekCall({ apiKey: config.providers.deepseekApiKey });
    const embedCall = config.providers.geminiApiKey ? createGeminiEmbed({ apiKey: config.providers.geminiApiKey }) : undefined;
    if (!config.analysisEnabled) log({ analysis: "disabled" });
    if (!embedCall) log({ embeddings: "disabled" });
    const embedBackoff = new EmbedBackoff();

    // Telegram only runs in --daemon (its poll loop is a background task for the life of the
    // process, unlike the one-shot queue tick above); --dry-run/--once behave exactly as before.
    if (config.telegram.enabled) {
      if (mode === "daemon") {
        const wiring = buildTelegramWiring(config, pool, objects, log);
        try {
          const me = await wiring.api.getMe();
          log({ telegram: "getMe", username: (me as { username?: string }).username ?? null, id: me.id });
        } catch (e) {
          log({ telegram: "getMe-failed", error: e instanceof Error ? e.message : String(e) });
        }
        await syncCommands(wiring.api); // never throws — logs its own failure
        telegramLoop = runTelegramLoop(wiring, log, controller.signal);
      } else {
        log({ telegram: "poll-loop-not-started-for-mode", mode });
      }
    }

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
              if (embedBackoff.shouldSkip()) {
                log({ embedTick: "skipped-backoff" });
              } else {
                try {
                  const embedState = await runEmbedTick({ pool, embed: embedCall, log }, controller.signal);
                  if (embedState !== "idle") log({ embedTick: embedState });
                  if (embedState === "error") embedBackoff.onError();
                  else embedBackoff.reset();
                } catch (e) {
                  log({ embedTickError: e instanceof Error ? e.message : String(e) });
                  embedBackoff.onError();
                }
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
    // Ensure the background telegramLoop (and anything else honoring `controller.signal`) is
    // actually being asked to stop before we await it below — if control reaches here via a
    // path that never called `stop()` (e.g. an exception escaping the main loop above), awaiting
    // telegramLoop without this would hang the process forever, since that loop only exits on
    // `signal.aborted`.
    controller.abort();
    await retentionSweep;
    await telegramLoop;
    await pool.end();
  }
}

main().catch((e) => { process.stderr.write(`worker failed: ${e instanceof Error ? e.message : e}\n`); process.exitCode = 1; });
