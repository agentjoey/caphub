import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { createDeepAnalysisDeps, runDeepAnalysis } from "../lib/analysis/deep";
import { createEnrichDeps, runEnrichment } from "../lib/analysis/enrich";
import { runPipeline } from "../lib/analysis/pipeline";
import { loadConfig, type WorkerConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { createDeepSeekCall } from "../lib/providers/deepseek";
import { createGeminiEmbed } from "../lib/providers/gemini-embed";
import { purgeDeletedCapabilities, sweepRetention } from "../lib/retention/retention";
import type { Lease, RunKind, RunOutcome } from "../lib/queue/runs";
import { RunQueue } from "../lib/queue/runs";
import { createObjectStore, type ObjectStore } from "../lib/storage/s3";
import { createTelegramApi, type TelegramApi } from "../lib/telegram/api";
import type { CaptureDeps } from "../lib/telegram/capture";
import { syncCommands } from "../lib/telegram/commands";
import { editCardAfterEnrich, type HandleCallbackDeps } from "../lib/telegram/decide";
import { runTelegramTick, type TelegramLoopDeps } from "../lib/telegram/loop";
import { runNotifyTick, type NotifyTickDeps } from "../lib/telegram/notify";
import type { SearchDeps } from "../lib/telegram/search";
import { EmbedBackoff } from "../lib/worker/embed-backoff";
import { runEmbedTick } from "../lib/worker/embeddings";
import { buildWorkerPipelines, selectPipelineDeps } from "../lib/worker/pipelines";
import { runReviewTick } from "../lib/worker/reviews";
import { runTick } from "../lib/worker/tick";
import { IdleTracker, idlePolicyFromEnv } from "../lib/worker/idle";
import { DEFAULT_WAKE_PORT, Waker, setLocalWakeHook, startWakeServer, wakeWorker } from "../lib/worker/wake";

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
  const loopDeps: TelegramLoopDeps = { pool, api, ownerChatId, capture, search, callback, log, offsetCache: { loaded: false, value: undefined } };
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
 * Whether the notify push has anything to look at (2026-10-12 Neon fix). Every push candidate
 * comes from work this worker itself just did (a finished or failed run, a Telegram-side rerun), so
 * the main loop bumps `due` after each busy cycle and the Telegram loop bumps it after handling
 * updates; the notify tick runs only while `done` lags behind, instead of two SELECTs every ~25 s
 * around the clock. A generation counter, not a flag: a bump that lands while a notify tick is
 * already in flight must not be cleared by that tick's (older) "idle" answer.
 */
interface NotifyDemand { due: number; done: number }

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
async function runTelegramLoop(wiring: TelegramWiring, demand: NotifyDemand, log: (o: Record<string, unknown>) => void, signal: AbortSignal): Promise<void> {
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
        // A failed offset write comes after its update was already handled (maybe queuing a run).
        if (result.reason === "save-offset-failed") {
          demand.due += 1;
          wakeWorker("telegram");
        }
      } else {
        if (result.kind === "processed") {
          log({ telegramTick: result });
          // A Telegram capture/rerun/decision may have queued work, and may need a push back.
          demand.due += 1;
          wakeWorker("telegram");
        }
        pollBackoff.reset();
      }
    } catch (e) {
      log({ telegramTickError: e instanceof Error ? e.message : String(e) });
      pollBackoff.onError();
    }
    if (signal.aborted) break;
    if (demand.done === demand.due) continue;
    if (notifyBackoff.shouldSkip()) {
      log({ notifyTick: "skipped-backoff", forMs: notifyBackoff.remainingMs() });
    } else {
      try {
        const generation = demand.due;
        const state = await runNotifyTick(wiring.notifyDeps, signal);
        if (state === "idle") demand.done = generation;
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

/** A failed check counts as "yes, open runs" — keep polling rather than sleep on unknown work. */
async function hasOpenRuns(queue: RunQueue, kinds: RunKind[], log: (o: Record<string, unknown>) => void): Promise<boolean> {
  try {
    return await queue.hasOpenRuns(kinds);
  } catch (e) {
    log({ openRunsCheckError: e instanceof Error ? e.message : String(e) });
    return true;
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
  let wakeServer: Server | null = null;
  const waker = new Waker();
  const idlePolicy = idlePolicyFromEnv(process.env);
  const idle = new IdleTracker(idlePolicy);
  const notifyDemand: NotifyDemand = { due: 1, done: 0 };
  try {
    if (mode === "dry-run") { log({ pipeline: config.pipeline, queue: await queue.summary() }); return; }
    const pipelines = buildWorkerPipelines(config, pool, objects);
    const reviewCall = createDeepSeekCall({ apiKey: config.providers.deepseekApiKey });
    const embedCall = config.providers.geminiApiKey ? createGeminiEmbed({ apiKey: config.providers.geminiApiKey }) : undefined;
    // Deep analysis (M3.6) needs both a DeepSeek key (always required for this role, see
    // WorkerConfig) and a Tavily key (optional, same requirement mixed/minimax_tavily pipelines
    // have) -- without the latter it's simply left unavailable, same treatment those get.
    const deepDeps = createDeepAnalysisDeps(config, pool);
    // Enrichment (M3.7) has the same two-key requirement as deep analysis (fixed DeepSeek +
    // Tavily deps, see createEnrichDeps), so it's unavailable under the exact same condition.
    const enrichDeps = createEnrichDeps(config, pool);
    if (!config.analysisEnabled) log({ analysis: "disabled" });
    if (!embedCall) log({ embeddings: "disabled" });
    if (!deepDeps) log({ deepAnalysis: "disabled", reason: "TAVILY_API_KEY not configured" });
    if (!enrichDeps) log({ enrichment: "disabled", reason: "TAVILY_API_KEY not configured" });
    const embedBackoff = new EmbedBackoff();
    // RunQueue's claim/heartbeat take a `kind` to scope themselves to one run kind's rows and
    // lease duration (analysis: 2 min, deep: 6 min -- see lib/queue/runs.ts); runTick's TickDeps
    // just wants `claim`/`heartbeat`/`finish` with `Lease`'s existing shape, so these two thin
    // adapters are all that's needed to drive the same runTick for both kinds.
    const analysisQueue = {
      claim: (token: string, now: Date) => queue.claim(token, now, "analysis"),
      heartbeat: (lease: Lease, now: Date) => queue.heartbeat(lease, now, "analysis"),
      finish: (lease: Lease, outcome: RunOutcome, now: Date) => queue.finish(lease, outcome, now)
    };
    const deepQueue = {
      claim: (token: string, now: Date) => queue.claim(token, now, "deep"),
      heartbeat: (lease: Lease, now: Date) => queue.heartbeat(lease, now, "deep"),
      finish: (lease: Lease, outcome: RunOutcome, now: Date) => queue.finish(lease, outcome, now)
    };
    const enrichQueue = {
      claim: (token: string, now: Date) => queue.claim(token, now, "enrich"),
      heartbeat: (lease: Lease, now: Date) => queue.heartbeat(lease, now, "enrich"),
      finish: (lease: Lease, outcome: RunOutcome, now: Date) => queue.finish(lease, outcome, now)
    };

    // Telegram only runs in --daemon (its poll loop is a background task for the life of the
    // process, unlike the one-shot queue tick above); --dry-run/--once behave exactly as before.
    if (config.telegram.enabled) {
      if (mode === "daemon") {
        const wiring = buildTelegramWiring(config, pool, objects, log);
        // M3.7 controller ruling: once Telegram is actually wired up (daemon mode, same gate as
        // the poll loop/notify tick above), enrichment edits the card's already-sent message in
        // place with its freshly enriched render — see lib/analysis/enrich.ts's
        // `EnrichDeps.notifyEnriched` and lib/telegram/decide.ts's `editCardAfterEnrich`.
        if (enrichDeps) {
          enrichDeps.notifyEnriched = (capabilityId, signal) => editCardAfterEnrich({ pool, api: wiring.api }, capabilityId, signal);
        }
        try {
          const me = await wiring.api.getMe();
          log({ telegram: "getMe", username: (me as { username?: string }).username ?? null, id: me.id });
        } catch (e) {
          log({ telegram: "getMe-failed", error: e instanceof Error ? e.message : String(e) });
        }
        await syncCommands(wiring.api); // never throws — logs its own failure
        telegramLoop = runTelegramLoop(wiring, notifyDemand, log, controller.signal);
      } else {
        log({ telegram: "poll-loop-not-started-for-mode", mode });
      }
    }

    // Idle sleep (2026-10-12 Neon fix, lib/worker/wake.ts): in --daemon, once nothing has happened
    // for the grace period and no run is queued or running, the loop stops querying and waits for
    // a wake — the web app's POST /wake, the Telegram loop's in-process hook — or the safety-net
    // self-wake. Without a working wake endpoint the web app couldn't reach it, so it then keeps
    // the old always-polling behaviour rather than risk sitting on a capture for hours.
    let canSleep = false;
    // Only run kinds this worker can actually process may hold it awake: a deep run queued while
    // TAVILY_API_KEY is unset will never be claimed here, and must not mean "never sleep".
    const openKinds: RunKind[] = ["analysis", ...(enrichDeps ? ["enrich" as const] : []), ...(deepDeps ? ["deep" as const] : [])];
    if (mode === "daemon") {
      setLocalWakeHook(() => waker.wake());
      const port = Number(process.env.WORKER_WAKE_PORT) || DEFAULT_WAKE_PORT;
      try {
        wakeServer = await startWakeServer({
          port,
          onWake: () => waker.wake(),
          onError: (error) => log({ wakeServer: "error", error: error.message })
        });
        canSleep = true;
        log({ wakeServer: "listening", port, idlePollMs: idlePolicy.idlePollMs });
      } catch (e) {
        log({ wakeServer: "failed", port, error: e instanceof Error ? e.message : String(e), fallback: "always-poll" });
      }
    }

    // Set while the embed tick is failing or backed off: stale embeddings aren't runs, so
    // hasOpenRuns can't see them — the sleep is then cut to the backoff's remaining wait instead
    // of the full idle poll, so the retry happens on the backoff's own schedule.
    let embedRetryPending = false;
    let nextRetention = 0;
    do {
      // Whether this cycle did anything; drives the idle sleep below.
      let busy = false;
      // Daily, not hourly: originals are kept 30 days, so a day's slack is immaterial, and an
      // hourly sweep alone would wake a sleeping database 24 times a day.
      if (config.retentionEnabled && !retentionSweep && Date.now() >= nextRetention) {
        nextRetention = Date.now() + 24 * 3_600_000;
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
            queue: analysisQueue,
            run: (lease, signal) => {
              const deps = selectPipelineDeps(pipelines, lease.pipeline);
              if (!deps) throw Object.assign(new Error(`no pipeline deps available for '${lease.pipeline}'`), { code: "PIPELINE_UNAVAILABLE" });
              return runPipeline(deps, lease, signal);
            },
            clock: () => new Date(),
            ownerToken: randomUUID,
            log
          }, controller.signal);
          if (state !== "idle") { log({ tick: state }); busy = true; }
          if (state === "idle") {
            // Worker priority order (M3.7 brief): 普通分析 → 补充调研 → 深度分析 → review → embed.
            // Enrichment (M3.7) is tried right after the normal analysis tick, before deep
            // analysis: a card entering `keep` gets its canonical-source rewrite before anyone
            // spends an 8-call deep-analysis budget on it. Same `kind` of run on the same
            // queue/lease machinery as deep; a thrown error from runTick's own `run` callback is
            // always caught inside runTick itself and recorded as the run's own failure (never
            // rethrown), so the try/catch here only guards against runTick's surrounding
            // plumbing (e.g. queue.claim itself failing) -- it must never end this loop.
            let enrichState: "idle" | "processed" = "idle";
            if (enrichDeps) {
              try {
                enrichState = await runTick({
                  queue: enrichQueue,
                  run: (lease, signal) => runEnrichment(enrichDeps, lease, signal),
                  clock: () => new Date(),
                  ownerToken: randomUUID,
                  log
                }, controller.signal);
                if (enrichState !== "idle") { log({ enrichTick: enrichState }); busy = true; }
              } catch (e) {
                log({ enrichTickError: e instanceof Error ? e.message : String(e) });
              }
            }
            // Deep analysis (M3.6) is tried next, before review/embed: same priority order as
            // the normal analysis tick above, just a different `kind` of run on the same
            // queue/lease machinery. A deep-analysis failure (a thrown error from runTick's own
            // `run` callback is always caught inside runTick itself and recorded as the run's
            // failure, never rethrown) must never end this loop -- the try/catch here only
            // guards against runTick's surrounding plumbing (e.g. queue.claim itself failing).
            let deepState: "idle" | "processed" = "idle";
            if (enrichState === "idle" && deepDeps) {
              try {
                deepState = await runTick({
                  queue: deepQueue,
                  run: (lease, signal) => runDeepAnalysis(deepDeps, lease, signal),
                  clock: () => new Date(),
                  ownerToken: randomUUID,
                  log
                }, controller.signal);
                if (deepState !== "idle") { log({ deepTick: deepState }); busy = true; }
              } catch (e) {
                log({ deepTickError: e instanceof Error ? e.message : String(e) });
              }
            }
            let reviewState: "idle" | "processed" = "idle";
            if (enrichState === "idle" && deepState === "idle") {
              try {
                reviewState = await runReviewTick({ pool, call: reviewCall, log }, controller.signal);
                if (reviewState !== "idle") { log({ reviewTick: reviewState }); busy = true; }
              } catch (e) {
                log({ reviewTickError: e instanceof Error ? e.message : String(e) });
              }
            }
            if (reviewState === "idle" && embedCall) {
              if (embedBackoff.shouldSkip()) {
                log({ embedTick: "skipped-backoff" });
                embedRetryPending = true;
              } else {
                try {
                  const embedState = await runEmbedTick({ pool, embed: embedCall, log }, controller.signal);
                  if (embedState !== "idle") log({ embedTick: embedState });
                  if (embedState === "embedded") busy = true;
                  embedRetryPending = embedState === "error";
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
      if (busy) notifyDemand.due += 1;
      idle.record(busy);
      if (canSleep && idle.maySleep() && !(config.analysisEnabled && await hasOpenRuns(queue, openKinds, log))) {
        const sleepMs = embedRetryPending
          ? Math.min(idlePolicy.idlePollMs, Math.max(embedBackoff.remainingMs(), idlePolicy.busyIntervalMs))
          : idlePolicy.idlePollMs;
        log({ worker: "sleeping", maxMs: sleepMs });
        const woke = await waker.wait(sleepMs, controller.signal);
        if (woke !== "aborted") log({ worker: woke === "woken" ? "woken" : "self-wake" });
        idle.reset();
      } else {
        await waker.wait(idlePolicy.busyIntervalMs, controller.signal);
      }
    } while (!controller.signal.aborted);
  } finally {
    // Ensure the background telegramLoop (and anything else honoring `controller.signal`) is
    // actually being asked to stop before we await it below — if control reaches here via a
    // path that never called `stop()` (e.g. an exception escaping the main loop above), awaiting
    // telegramLoop without this would hang the process forever, since that loop only exits on
    // `signal.aborted`.
    controller.abort();
    setLocalWakeHook(null);
    if (wakeServer) await new Promise((resolve) => wakeServer!.close(resolve));
    await retentionSweep;
    await telegramLoop;
    await pool.end();
  }
}

main().catch((e) => { process.stderr.write(`worker failed: ${e instanceof Error ? e.message : e}\n`); process.exitCode = 1; });
