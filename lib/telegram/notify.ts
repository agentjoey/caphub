import type { Pool } from "pg";
import type { CapabilityType } from "../analysis/card";
import { loadScenarios } from "../analysis/scenarios";
import type { Progress } from "../library/labels";
import { TODO_PROGRESS } from "../library/queries";
import type { InlineKeyboardMarkup, TelegramApi } from "./api";
import { TelegramError } from "./errors";
import { formatResult, type DecidedCardInput, type FailedCardInput, type FormatCardInput, type TodoCardInput } from "./format";

const BATCH_SIZE = 10;

export interface Candidate {
  id: string;
  captureId: string;
  title: string;
  type: CapabilityType;
  usage: "integrate" | "reference";
  suggestedVerdict: "keep" | "discard";
  suggestedReason: string;
  summary: string;
  tags: string[];
  scenarios: string[];
  serial: number | null;
  /** AI value score 1–5, or null for a card scored before M3.5's backfill — never rendered as a 0. */
  score: number | null;
  scoreReason: string | null;
  /** Self-build progress — only meaningful for `usage = 'reference'` cards (see setProgress). */
  progress: Progress;
  verdict: "keep" | "discard" | "pending";
  updatedAt: Date;
  telegramChatId: string | null;
  telegramMessageId: string | null;
  runState: "done" | "failed";
  errorCode: string | null;
}

export interface NotifyTickDeps {
  pool: Pool;
  api: Pick<TelegramApi, "sendMessage" | "editMessageText">;
  ownerChatId: number | string;
  log?: (o: Record<string, unknown>) => void;
}

/** True for a transport failure (network error/timeout), a 429, or a 5xx — all transient and should back off/retry, not retire the card. */
function isTransient(error: unknown): boolean {
  if (!(error instanceof TelegramError)) return false;
  if (error.code === 0 || error.code === 429) return true;
  return error.code >= 500 && error.code < 600;
}

/**
 * True for a non-transient 4xx (e.g. 403 "bot was blocked by the user", 400 "chat not found",
 * or 400 for a message over Telegram's length limit) — a permanent, card-local failure that will
 * never succeed on retry, so the card must be retired rather than re-selected forever. Checked
 * only after {@link isGlobalAuthFailure} and {@link isEntityParseError} have ruled themselves
 * out — both are also non-transient 4xx codes, but neither is a card-local failure.
 */
function isPermanentClientError(error: unknown): error is TelegramError {
  return error instanceof TelegramError && error.code >= 400 && error.code < 500 && error.code !== 429;
}

/** Telegram returns 400 "Bad Request: message is not modified" when an edit is byte-identical to the current message — this is a success (the message already reflects the intended state), not evidence the stored receipt is gone. */
function isMessageNotModified(error: unknown): boolean {
  return error instanceof TelegramError && error.code === 400 && error.description.toLowerCase().includes("message is not modified");
}

/**
 * True for a 400 Telegram rejects as malformed HTML (e.g. "Bad Request: can't parse entities:
 * Unsupported start tag …") — a formatting bug in *our* rendering, not evidence the chat/message
 * is gone. This must never be treated as {@link isPermanentClientError} (which would retire the
 * card as if it had been delivered): the card should stay pending and get a fresh chance once
 * the formatting bug producing it is fixed, or once `format.ts`'s own shrinking (which should
 * make this unreachable in practice) avoids it entirely.
 */
function isEntityParseError(error: unknown): error is TelegramError {
  if (!(error instanceof TelegramError) || error.code !== 400) return false;
  const d = error.description.toLowerCase();
  return d.includes("parse") || d.includes("entit");
}

/**
 * True for an auth failure that isn't scoped to one chat: a 401 (invalid/revoked bot token)
 * always, or a 403 that isn't the well-known "bot was blocked by the user" per-chat message
 * (e.g. a generic "Forbidden" surfaced by a bad token or removed integration). Unlike a
 * card-local permanent failure, this affects every push in the batch — retiring candidates one
 * by one here would silently hide a global misconfiguration behind a slow trickle of retired
 * cards instead of surfacing it as the tick-level error it actually is.
 */
function isGlobalAuthFailure(error: unknown): error is TelegramError {
  if (!(error instanceof TelegramError)) return false;
  if (error.code === 401) return true;
  if (error.code === 403) return !error.description.toLowerCase().includes("blocked by the user");
  return false;
}

/** Postgres error code (e.g. '23505'), when the thrown value carries one — never the error message, which may embed row content. */
function dbErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

/**
 * Builds `formatResult`'s input for one candidate. A failed latest run only ever needs the
 * narrow {@link FailedCardInput} shape (see format.ts) — the capability's other columns may be
 * stale (from an earlier successful run) or, for a future failed-run-with-no-capability
 * selection branch, simply absent.
 */
export function buildFormatInput(candidate: Candidate, scenarioLabel: Map<string, string>): FormatCardInput {
  if (candidate.runState === "failed") {
    // ...unless the card is a self-build candidate (the same rows `/todo` lists). Replacing one
    // of those with the bare 「分析失败」 card drops its 进度 line and its progress buttons — and
    // because this push EDITS the card's stored Telegram message, it would also overwrite a
    // `/todo` card the owner is looking at. Such a card keeps its self-build rendering and only
    // gains a muted note about the failed run.
    if (isSelfBuildCard(candidate)) return buildTodoFormatInput(candidate, scenarioLabel);
    const input: FailedCardInput = { status: "failed", id: candidate.id, updatedAt: candidate.updatedAt.toISOString(), errorCode: candidate.errorCode };
    return input;
  }
  const input: DecidedCardInput = {
    status: candidate.verdict,
    id: candidate.id,
    title: candidate.title,
    type: candidate.type,
    usage: candidate.usage,
    suggestedVerdict: candidate.suggestedVerdict,
    suggestedReason: candidate.suggestedReason,
    summary: candidate.summary,
    tags: candidate.tags,
    scenarioLabels: candidate.scenarios.map((slug) => scenarioLabel.get(slug) ?? slug),
    serial: candidate.serial,
    score: candidate.score,
    scoreReason: candidate.scoreReason,
    updatedAt: candidate.updatedAt.toISOString()
  };
  return input;
}

/**
 * Builds a `/todo` self-build card's `formatResult` input (see format.ts's `formatTodo`) from a
 * candidate — used by decide.ts to re-render a `/todo` card in place after a progress-button
 * press (see `handleProgress`). Unlike {@link buildFormatInput}, this never branches on
 * `runState`/`verdict`: a `/todo` card is, by construction, already a kept `usage='reference'`
 * card with a self-build `progress` to show.
 */
export function buildTodoFormatInput(candidate: Candidate, scenarioLabel: Map<string, string>): TodoCardInput {
  return {
    status: "todo",
    lastRunError: candidate.runState === "failed" ? candidate.errorCode : undefined,
    id: candidate.id,
    title: candidate.title,
    type: candidate.type,
    summary: candidate.summary,
    tags: candidate.tags,
    scenarioLabels: candidate.scenarios.map((slug) => scenarioLabel.get(slug) ?? slug),
    serial: candidate.serial,
    score: candidate.score,
    scoreReason: candidate.scoreReason,
    progress: candidate.progress,
    updatedAt: candidate.updatedAt.toISOString()
  };
}

/** True for a card `/todo` would list: kept, `usage='reference'`, and still awaiting/undergoing self-build. */
function isSelfBuildCard(candidate: Candidate): boolean {
  return candidate.verdict === "keep" && candidate.usage === "reference" && TODO_PROGRESS.includes(candidate.progress);
}

/**
 * Column list + join shared by every query that loads a `Candidate` row, so
 * {@link selectCandidates} (batch, unnotified) and {@link loadCandidateById} (single row, by id,
 * regardless of notified state — used by decide.ts to render a card back into a Telegram
 * message) stay in lockstep instead of drifting into two shapes for the same data.
 */
const CANDIDATE_COLUMNS = `cb.id, cb.capture_id AS "captureId", cb.title, cb.type, cb.usage,
            cb.suggested_verdict AS "suggestedVerdict", cb.suggested_reason AS "suggestedReason",
            cb.summary, cb.tags, cb.scenarios, cb.serial, cb.score, cb.score_reason AS "scoreReason",
            cb.progress, cb.verdict, cb.updated_at AS "updatedAt",
            c.telegram_chat_id AS "telegramChatId", c.telegram_message_id AS "telegramMessageId",
            lr.state AS "runState", lr.error_code AS "errorCode"`;

const CANDIDATE_FROM = `FROM caphub_v2.capabilities cb
     JOIN caphub_v2.captures c ON c.id = cb.capture_id
     JOIN LATERAL (
       SELECT state, error_code FROM caphub_v2.analysis_runs
       WHERE capture_id = cb.capture_id ORDER BY created_at DESC LIMIT 1
     ) lr ON true`;

/**
 * Selects up to {@link BATCH_SIZE} capabilities that need a push (an already-decided verdict, or
 * a failed latest run) and haven't been pushed yet. Not restricted to `c.source = 'telegram'` —
 * a web-sourced capture whose card the owner is following in Telegram (its capture carries a
 * stored `telegram_chat_id`/`telegram_message_id`, recorded by `/pending` or a rerun button —
 * see commands.ts and decide.ts) is just as eligible: the condition that matters is whether there
 * is a Telegram message to push the result to, not where the capture originated. The "latest run"
 * is looked up by `capture_id` (not `capabilities.run_id`, which points at the run that produced
 * the stored card) so a failed *rerun* of an already-decided card is detected even though the
 * card's own columns still hold the previous, successful run's data; only a finished run
 * ('done' or 'failed') qualifies, so a rerun still in flight (queued/running — its
 * `notified_at` was already cleared when it was queued) is left alone until it finishes.
 */
async function selectCandidates(pool: Pool): Promise<Candidate[]> {
  const { rows } = await pool.query<Candidate>(
    `SELECT ${CANDIDATE_COLUMNS}
     ${CANDIDATE_FROM}
     WHERE cb.notified_at IS NULL AND cb.deleted_at IS NULL
       AND c.telegram_chat_id IS NOT NULL AND c.telegram_message_id IS NOT NULL
       AND lr.state IN ('done', 'failed')
     ORDER BY cb.updated_at
     LIMIT ${BATCH_SIZE}`
  );
  return rows;
}

/**
 * Loads one candidate by capability id, regardless of `notified_at` (unlike
 * {@link selectCandidates}) — used by decide.ts to re-render a card's current state (e.g. after
 * a decision, or when a Telegram button turns out stale). Returns `null` for a missing or
 * soft-deleted capability, or one with no analysis run yet (shouldn't happen for a card that was
 * ever pushed).
 */
export async function loadCandidateById(pool: Pool, id: string): Promise<Candidate | null> {
  const { rows } = await pool.query<Candidate>(
    `SELECT ${CANDIDATE_COLUMNS}
     ${CANDIDATE_FROM}
     WHERE cb.id = $1 AND cb.deleted_at IS NULL`,
    [id]
  );
  return rows[0] ?? null;
}

async function markNotified(pool: Pool, id: string): Promise<void> {
  await pool.query("UPDATE caphub_v2.capabilities SET notified_at = now() WHERE id = $1", [id]);
}

/** Persists a message id sent as a fallback (no stored receipt, or the receipt was gone), so a later re-push (e.g. after a rerun) can edit it instead of sending yet another new message. */
async function recordMessageId(pool: Pool, capabilityId: string, messageId: number): Promise<void> {
  await pool.query(
    `UPDATE caphub_v2.captures SET telegram_message_id = $2
     WHERE id = (SELECT capture_id FROM caphub_v2.capabilities WHERE id = $1)`,
    [capabilityId, String(messageId)]
  );
}

/**
 * A capture whose FIRST analysis run failed, with no capability row (see
 * {@link selectFailedCaptureRuns}). Deliberately narrow, like {@link Candidate} isn't reused
 * here — this only ever renders via `FailedCardInput` with `target: "capture"`.
 */
export interface CaptureFailure {
  captureId: string;
  runId: string;
  errorCode: string | null;
  updatedAt: Date;
  telegramChatId: string | null;
  telegramMessageId: string | null;
}

/**
 * Selects up to {@link BATCH_SIZE} captures with a Telegram message to push to whose latest
 * analysis run failed and was never pushed, and which have no capability row at all (a first-run
 * failure — see Ruling 1 in the Task 7 brief: a card only gets a capabilities row once *some* run
 * succeeds, so a capture stuck on repeated failures would otherwise never be notified). Like
 * {@link selectCandidates}, gated on the capture having stored Telegram ids rather than on
 * `c.source = 'telegram'`. One row per capture (its most recent still-unnotified failed run), so
 * an older failed run for the same capture is left as-is rather than double-pushed.
 *
 * TODO: an older superseded failed run for the same capture (one that was itself never
 * notified, now shadowed by this capture's latest failed run) is permanently skipped by
 * `DISTINCT ON (c.id)` above — it's never pushed and never marked notified. Low-risk (bounded,
 * doesn't affect current behavior beyond that one run's push being silently dropped) but should
 * eventually either mark those rows notified too, or push them as a single combined message.
 */
async function selectFailedCaptureRuns(pool: Pool): Promise<CaptureFailure[]> {
  const { rows } = await pool.query<CaptureFailure>(
    `SELECT DISTINCT ON (c.id)
       c.id AS "captureId", ar.id AS "runId", ar.error_code AS "errorCode",
       coalesce(ar.finished_at, ar.created_at) AS "updatedAt",
       c.telegram_chat_id AS "telegramChatId", c.telegram_message_id AS "telegramMessageId"
     FROM caphub_v2.captures c
     JOIN caphub_v2.analysis_runs ar ON ar.capture_id = c.id
     WHERE c.telegram_chat_id IS NOT NULL AND c.telegram_message_id IS NOT NULL
       AND ar.state = 'failed' AND ar.notified_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM caphub_v2.capabilities k WHERE k.capture_id = c.id)
     ORDER BY c.id, ar.created_at DESC
     LIMIT ${BATCH_SIZE}`
  );
  return rows;
}

function buildCaptureFailureFormatInput(failure: CaptureFailure): FailedCardInput {
  return { status: "failed", id: failure.captureId, updatedAt: failure.updatedAt.toISOString(), errorCode: failure.errorCode, target: "capture" };
}

async function markRunNotified(pool: Pool, runId: string): Promise<void> {
  await pool.query("UPDATE caphub_v2.analysis_runs SET notified_at = now() WHERE id = $1", [runId]);
}

/** {@link recordMessageId}'s counterpart for a {@link CaptureFailure} — `id` is already the capture id, no capability indirection needed. */
async function recordMessageIdForCapture(pool: Pool, captureId: string, messageId: number): Promise<void> {
  await pool.query("UPDATE caphub_v2.captures SET telegram_message_id = $2 WHERE id = $1", [captureId, String(messageId)]);
}

/** The subset of a {@link Candidate} or {@link CaptureFailure} that {@link deliver} needs — just enough to address and identify a push, regardless of what kind of row it came from. */
interface PushTarget {
  /** Logged/passed to `recordMessageId` to identify the row — a capability id or a capture id, depending on the caller. */
  id: string;
  telegramChatId: string | null;
  telegramMessageId: string | null;
}

/**
 * Pushes (or edits) exactly one card's Telegram message, given already-rendered `text`/
 * `replyMarkup`. Returns "notified" on success, "retired" for a permanent, card-local failure
 * (e.g. the owner blocked the bot, the chat is gone, or the message is too long) that will never
 * succeed on retry and must not keep head-of-line-blocking the batch, "skipped" for some other
 * card-local issue (nothing to retry differently, but also not confidently permanent), or
 * "error" for a transient Telegram-side failure (429 / 5xx / network) that should trigger
 * backoff. `recordMessageId` is injected so the same delivery logic serves both selection
 * branches (a capability id vs. a capture id — see {@link recordMessageId} and
 * {@link recordMessageIdForCapture}).
 */
async function deliver(
  deps: NotifyTickDeps,
  target: PushTarget,
  rendered: { text: string; replyMarkup?: InlineKeyboardMarkup },
  recordMessageId: (pool: Pool, id: string, messageId: number) => Promise<void>
): Promise<"notified" | "retired" | "skipped" | "error"> {
  const chatId = target.telegramChatId ?? deps.ownerChatId;
  const messageId = target.telegramMessageId ? Number(target.telegramMessageId) : null;

  if (messageId !== null) {
    try {
      // An edit that no longer wants buttons (keep/discard) must pass an *explicit* empty
      // keyboard — Telegram keeps whatever keyboard the message already had (e.g. the pending
      // card's 保留/丢弃/重跑分析 row) when `reply_markup` is omitted from editMessageText.
      const replyMarkup: InlineKeyboardMarkup = rendered.replyMarkup ?? { inline_keyboard: [] };
      await deps.api.editMessageText({ chatId, messageId, text: rendered.text, replyMarkup });
      return "notified";
    } catch (error) {
      if (isMessageNotModified(error)) {
        // The message already shows the intended text/buttons (a rerun's edit — see decide.ts —
        // can leave the receipt byte-identical to what this tick would send) — a no-op success,
        // not evidence the stored receipt is gone.
        return "notified";
      }
      if (isTransient(error)) {
        deps.log?.({ notify: "edit-failed-transient", capability: target.id });
        return "error";
      }
      deps.log?.({ notify: "edit-failed-fallback-send", capability: target.id });
      // Fall through to a fresh send below — the stored receipt message is gone or can no
      // longer be edited. A permanent client error here (e.g. the chat itself is gone) will
      // reproduce on the send attempt below and be retired there.
    }
  }

  let sent;
  try {
    sent = await deps.api.sendMessage({ chatId, text: rendered.text, replyMarkup: rendered.replyMarkup });
  } catch (error) {
    if (isTransient(error)) {
      deps.log?.({ notify: "send-failed-transient", capability: target.id });
      return "error";
    }
    if (isGlobalAuthFailure(error)) {
      // A revoked/invalid bot token (or an otherwise non-chat-scoped Forbidden) breaks every
      // push, not just this one — surfaced loudly as a tick-level error (triggers the caller's
      // backoff) instead of quietly retiring every candidate in the batch one by one, which
      // would hide a global misconfiguration behind a trickle of individually "handled" cards.
      deps.log?.({ notify: "send-failed-auth", capability: target.id, code: error.code, description: error.description });
      return "error";
    }
    if (isEntityParseError(error)) {
      // A formatting bug in our own rendering (malformed HTML), not evidence the card is
      // undeliverable — must never be retired (that would silently mark it delivered when it
      // never was). Left unnotified so it's retried once the bug is fixed.
      deps.log?.({ notify: "send-failed-parse-error", capability: target.id, code: error.code, description: error.description });
      return "skipped";
    }
    if (isPermanentClientError(error)) {
      // Non-transient, non-429 4xx (owner blocked the bot, chat not found, message too long,
      // etc.) will never succeed on retry — retiring it (the caller marks it notified) keeps it
      // from head-of-line-blocking every newer card behind it in selectCandidates' batch.
      deps.log?.({ notify: "send-failed-permanent-retired", capability: target.id, code: error.code, description: error.description });
      return "retired";
    }
    deps.log?.({ notify: "send-failed", capability: target.id });
    return "skipped";
  }

  if (sent && typeof sent === "object" && typeof sent.message_id === "number") {
    try {
      await recordMessageId(deps.pool, target.id, sent.message_id);
    } catch (error) {
      // The push itself already succeeded — but without this write, a later re-push (e.g.
      // after a rerun) would blindly re-send instead of editing. Treat the candidate as failed
      // for this tick (skip markNotified below) rather than risk losing track of the message.
      deps.log?.({ notify: "record-message-id-failed", capability: target.id, code: dbErrorCode(error) });
      return "error";
    }
  }
  return "notified";
}

/**
 * Pushes decided/failed cards with a Telegram message to update to the owner chat, one tick at
 * a time (see
 * {@link selectCandidates}). A card whose formatting throws, or whose `markNotified`/
 * `recordMessageId` write throws, is logged and skipped — never allowed to abort the rest of
 * the tick. Returns "error" if any candidate hit a transient Telegram failure (429/network) or
 * a DB write failure (so the caller backs off, even if other candidates in the same batch were
 * pushed successfully), "notified" if the tick was otherwise clean and at least one card was
 * pushed, or "idle" when there was nothing to do.
 */
export async function runNotifyTick(deps: NotifyTickDeps, signal: AbortSignal): Promise<"idle" | "notified" | "error"> {
  if (signal.aborted) return "idle";
  const candidates = await selectCandidates(deps.pool);
  const captureFailures = await selectFailedCaptureRuns(deps.pool);
  if (candidates.length === 0 && captureFailures.length === 0) return "idle";

  const scenarios = await loadScenarios(deps.pool);
  const scenarioLabel = new Map(scenarios.map((s) => [s.slug, s.labelZh]));

  let notified = 0;
  let sawError = false;

  for (const candidate of candidates) {
    if (signal.aborted) break;
    let rendered;
    try {
      rendered = formatResult(buildFormatInput(candidate, scenarioLabel));
    } catch (error) {
      deps.log?.({ notify: "format-failed", capability: candidate.id, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const outcome = await deliver(deps, candidate, rendered, recordMessageId);
    if (outcome === "notified" || outcome === "retired") {
      try {
        await markNotified(deps.pool, candidate.id);
        if (outcome === "notified") notified += 1;
      } catch (error) {
        // The push already succeeded, but a transient pool error here must not throw out of
        // the tick (it would abort the rest of the batch) and must not be treated as a success
        // (that would leave notified_at NULL, causing a duplicate push next tick — reported and
        // instead surfaced as this tick's "error" so the caller can back off).
        deps.log?.({ notify: "mark-notified-failed", capability: candidate.id, code: dbErrorCode(error) });
        sawError = true;
      }
    } else if (outcome === "error") {
      sawError = true;
    }
  }

  // Second selection branch (Ruling 1): a capture whose first analysis run failed, so there is
  // no capability row to key the push off of — see selectFailedCaptureRuns.
  for (const failure of captureFailures) {
    if (signal.aborted) break;
    let rendered;
    try {
      rendered = formatResult(buildCaptureFailureFormatInput(failure));
    } catch (error) {
      deps.log?.({ notify: "format-failed", capture: failure.captureId, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const target: PushTarget = { id: failure.captureId, telegramChatId: failure.telegramChatId, telegramMessageId: failure.telegramMessageId };
    const outcome = await deliver(deps, target, rendered, recordMessageIdForCapture);
    if (outcome === "notified" || outcome === "retired") {
      try {
        await markRunNotified(deps.pool, failure.runId);
        if (outcome === "notified") notified += 1;
      } catch (error) {
        deps.log?.({ notify: "mark-run-notified-failed", runId: failure.runId, code: dbErrorCode(error) });
        sawError = true;
      }
    } else if (outcome === "error") {
      sawError = true;
    }
  }

  deps.log?.({ notify: "done", notified, total: candidates.length + captureFailures.length });
  // A transient/DB error anywhere in the batch means the caller should back off, even if other
  // candidates in the same batch were pushed successfully — "notified" is reserved for a
  // fully-clean tick.
  if (sawError) return "error";
  if (notified > 0) return "notified";
  return "idle";
}
