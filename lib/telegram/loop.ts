import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import type { CaptureDeps } from "./capture";
import { handleCapture } from "./capture";
import type { CommandDeps } from "./commands";
import { handleCommand } from "./commands";
import type { HandleCallbackDeps } from "./decide";
import { handleCallback } from "./decide";
import { TelegramError } from "./errors";
import type { SearchDeps } from "./search";
import { handleSearch } from "./search";
import { classifyUpdate, type RouterUpdate } from "./router";
import type { TelegramApi, TelegramUpdate } from "./api";

/** The `key` this loop's offset is stored under in `caphub_v2.telegram_state` (see migration 006). */
const OFFSET_KEY = "getUpdates_offset";
/** Long-poll duration passed to `getUpdates` — Telegram holds the request open up to this many seconds waiting for an update. */
const POLL_TIMEOUT_SECONDS = 25;
/**
 * Floor on how often an idle tick returns, in case `getUpdates` ever comes back immediately
 * instead of holding for {@link POLL_TIMEOUT_SECONDS} (e.g. a proxy in front of Telegram that
 * doesn't honor long-poll timeouts) — without this, that would spin the caller's loop.
 */
const MIN_IDLE_INTERVAL_MS = 1_000;

/**
 * The four update handlers this loop dispatches to (Tasks 3–6). Overridable purely for testing —
 * so a test can prove a handler failure never wedges the loop (offset still advances, other
 * updates in the same tick still process) without relying on every real handler's own internal
 * safety net staying total forever.
 */
export interface TelegramLoopHandlers {
  handleCapture: typeof handleCapture;
  handleSearch: typeof handleSearch;
  handleCommand: typeof handleCommand;
  handleCallback: typeof handleCallback;
}

const defaultHandlers: TelegramLoopHandlers = { handleCapture, handleSearch, handleCommand, handleCallback };

export interface TelegramLoopDeps {
  pool: Pool;
  api: Pick<TelegramApi, "getUpdates">;
  ownerChatId: number;
  capture: CaptureDeps;
  /** Also used as `CommandDeps` (`CommandDeps` is exactly `SearchDeps` — see commands.ts). */
  search: SearchDeps;
  callback: HandleCallbackDeps;
  handlers?: Partial<TelegramLoopHandlers>;
  /** Overrides {@link MIN_IDLE_INTERVAL_MS} — test-only (production always uses the real floor). */
  minIdleIntervalMs?: number;
  log?: (o: Record<string, unknown>) => void;
}

export type TelegramTickOutcome =
  | { kind: "idle" }
  | { kind: "processed"; count: number }
  /** `retryAfterMs` is set when the failure was a Telegram 429 that told us how long to wait — callers should prefer it over their own backoff's doubling delay. */
  | { kind: "error"; reason: string; retryAfterMs?: number };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `retry_after` on a 429 is in seconds (Telegram's `parameters.retry_after`); callers want ms. */
function retryAfterMs(error: unknown): number | undefined {
  return error instanceof TelegramError && error.code === 429 && error.retryAfter !== undefined
    ? error.retryAfter * 1000
    : undefined;
}

async function loadOffset(pool: Pool, log?: (o: Record<string, unknown>) => void): Promise<number | undefined> {
  const { rows } = await pool.query<{ value: string }>(
    "SELECT value FROM caphub_v2.telegram_state WHERE key = $1", [OFFSET_KEY]
  );
  const raw = rows[0]?.value;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    log?.({ telegram: "invalid-stored-offset", value: raw });
    return undefined;
  }
  return n;
}

async function saveOffset(pool: Pool, offset: number): Promise<void> {
  await pool.query(
    `INSERT INTO caphub_v2.telegram_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [OFFSET_KEY, String(offset)]
  );
}

/**
 * Routes one classified update to its handler (Tasks 3–6). Every real handler already has its
 * own total try/catch (never throws by design — see their docstrings), but this loop must
 * tolerate a handler throwing anyway, so a bug in one handler can never wedge the poll loop on a
 * single "poison" update — see the try/catch around this call in {@link runTelegramTick}.
 */
async function dispatch(
  deps: TelegramLoopDeps,
  handlers: TelegramLoopHandlers,
  update: TelegramUpdate,
  signal: AbortSignal,
  ignoredCounts: Record<string, number>
): Promise<void> {
  const classified = classifyUpdate(update as RouterUpdate, { ownerChatId: deps.ownerChatId });
  switch (classified.kind) {
    case "ignored":
      // Silently dropped by design (not-owner, malformed callback, unsupported message shape,
      // …) — tallied here and logged once per tick (see runTelegramTick) rather than per update,
      // so a misconfigured TELEGRAM_OWNER_CHAT_ID (every update classifying as not-owner) still
      // leaves a diagnostic trail instead of looking like a silently dead bot.
      ignoredCounts[classified.reason] = (ignoredCounts[classified.reason] ?? 0) + 1;
      return;
    case "image":
    case "url":
    case "text-capture":
      await handlers.handleCapture(deps.capture, classified);
      return;
    case "search":
      await handlers.handleSearch(deps.search, { chatId: classified.chatId, messageId: classified.messageId, query: classified.query });
      return;
    case "command":
      await handlers.handleCommand(deps.search as CommandDeps, { chatId: classified.chatId, messageId: classified.messageId, name: classified.name, arg: classified.arg });
      return;
    case "callback":
      await handlers.handleCallback(deps.callback, classified, signal);
      return;
  }
}

/**
 * One poll tick: reads the persisted `getUpdates` offset, long-polls Telegram for up to
 * {@link POLL_TIMEOUT_SECONDS}, routes every update it gets back (Tasks 2–6), and persists the
 * offset after each update is handled — so a crash mid-batch reprocesses at most the update it
 * died on, never more. A handler failure (or a classify result the handler can't act on) is
 * logged and the offset still advances past it, so a single poison update can never wedge the
 * loop forever. Never throws.
 */
export async function runTelegramTick(deps: TelegramLoopDeps, signal: AbortSignal): Promise<TelegramTickOutcome> {
  if (signal.aborted) return { kind: "idle" };
  const handlers: TelegramLoopHandlers = { ...defaultHandlers, ...deps.handlers };

  let offset: number | undefined;
  try {
    offset = await loadOffset(deps.pool, deps.log);
  } catch (error) {
    deps.log?.({ telegram: "load-offset-failed", error: errorMessage(error) });
    return { kind: "error", reason: "load-offset-failed" };
  }

  const startedAt = Date.now();
  let updates: TelegramUpdate[];
  try {
    updates = await deps.api.getUpdates({ offset, timeout: POLL_TIMEOUT_SECONDS, signal });
  } catch (error) {
    deps.log?.({ telegram: "get-updates-failed", error: errorMessage(error) });
    return { kind: "error", reason: "get-updates-failed", retryAfterMs: retryAfterMs(error) };
  }

  if (updates.length === 0) {
    // getUpdates is a long poll — it should have held for ~POLL_TIMEOUT_SECONDS if there was
    // nothing to return. If it came back much faster than that (a proxy in front of Telegram
    // that doesn't honor long-poll timeouts), wait out a floor here so the caller's loop doesn't
    // spin on an effectively-instant "nothing to do" tick.
    const floorMs = deps.minIdleIntervalMs ?? MIN_IDLE_INTERVAL_MS;
    const elapsed = Date.now() - startedAt;
    if (elapsed < floorMs) {
      await delay(floorMs - elapsed, undefined, { signal }).catch(() => {});
    }
    return { kind: "idle" };
  }

  let processed = 0;
  const ignoredCounts: Record<string, number> = {};
  for (const update of updates) {
    if (signal.aborted) break;
    try {
      await dispatch(deps, handlers, update, signal, ignoredCounts);
    } catch (error) {
      deps.log?.({ telegram: "dispatch-failed", updateId: update.update_id, error: errorMessage(error) });
    }
    try {
      await saveOffset(deps.pool, update.update_id + 1);
    } catch (error) {
      // The offset write itself failed — stop here rather than risk drifting silently. The next
      // tick retries from the last successfully persisted offset, so this update (and any after
      // it in this batch) may be reprocessed, which every handler tolerates (capture dedupes,
      // decide/requestRerun are idempotent under their own conflict checks).
      deps.log?.({ telegram: "save-offset-failed", updateId: update.update_id, error: errorMessage(error) });
      if (Object.keys(ignoredCounts).length > 0) deps.log?.({ telegram: "ignored", counts: ignoredCounts });
      return processed > 0 ? { kind: "processed", count: processed } : { kind: "error", reason: "save-offset-failed" };
    }
    processed += 1;
  }

  if (Object.keys(ignoredCounts).length > 0) deps.log?.({ telegram: "ignored", counts: ignoredCounts });
  return processed > 0 ? { kind: "processed", count: processed } : { kind: "idle" };
}
