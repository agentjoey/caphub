import type { Pool } from "pg";
import type { CapabilityType } from "../analysis/card";
import { loadScenarios } from "../analysis/scenarios";
import type { InlineKeyboardMarkup, TelegramApi } from "./api";
import { TelegramError } from "./errors";
import { formatResult, type ResultStatus } from "./format";

const BATCH_SIZE = 10;

interface Candidate {
  id: string;
  title: string;
  type: CapabilityType;
  usage: "integrate" | "reference";
  suggestedVerdict: "keep" | "discard";
  suggestedReason: string;
  summary: string;
  tags: string[];
  scenarios: string[];
  serial: number | null;
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

/** True for a transport failure (network error/timeout) or a 429 — both are transient and should back off, not fall back to a fresh send. */
function isTransient(error: unknown): boolean {
  return error instanceof TelegramError && (error.code === 0 || error.code === 429);
}

function statusOf(candidate: Candidate): ResultStatus {
  if (candidate.runState === "failed") return "failed";
  return candidate.verdict;
}

/**
 * Selects up to {@link BATCH_SIZE} Telegram-sourced capabilities that need a push (an already
 * -decided verdict, or a failed latest run) and haven't been pushed yet. The "latest run" is
 * looked up by `capture_id` (not `capabilities.run_id`, which points at the run that produced
 * the stored card) so a failed *rerun* of an already-decided card is detected even though the
 * card's own columns still hold the previous, successful run's data; only a finished run
 * ('done' or 'failed') qualifies, so a rerun still in flight (queued/running — its
 * `notified_at` was already cleared when it was queued) is left alone until it finishes.
 */
async function selectCandidates(pool: Pool): Promise<Candidate[]> {
  const { rows } = await pool.query<Candidate>(
    `SELECT cb.id, cb.title, cb.type, cb.usage,
            cb.suggested_verdict AS "suggestedVerdict", cb.suggested_reason AS "suggestedReason",
            cb.summary, cb.tags, cb.scenarios, cb.serial, cb.verdict, cb.updated_at AS "updatedAt",
            c.telegram_chat_id AS "telegramChatId", c.telegram_message_id AS "telegramMessageId",
            lr.state AS "runState", lr.error_code AS "errorCode"
     FROM caphub_v2.capabilities cb
     JOIN caphub_v2.captures c ON c.id = cb.capture_id
     JOIN LATERAL (
       SELECT state, error_code FROM caphub_v2.analysis_runs
       WHERE capture_id = cb.capture_id ORDER BY created_at DESC LIMIT 1
     ) lr ON true
     WHERE cb.notified_at IS NULL AND cb.deleted_at IS NULL AND c.source = 'telegram'
       AND lr.state IN ('done', 'failed')
     ORDER BY cb.updated_at
     LIMIT ${BATCH_SIZE}`
  );
  return rows;
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
 * Pushes (or edits) exactly one card's Telegram message, given already-rendered `text`/
 * `replyMarkup`. Returns "notified" on success, "skipped" for a card-local issue (nothing to
 * retry differently), or "error" for a transient Telegram-side failure (429 / network) that
 * should trigger backoff.
 */
async function deliver(
  deps: NotifyTickDeps,
  candidate: Candidate,
  rendered: { text: string; replyMarkup?: InlineKeyboardMarkup }
): Promise<"notified" | "skipped" | "error"> {
  const chatId = candidate.telegramChatId ?? deps.ownerChatId;
  const messageId = candidate.telegramMessageId ? Number(candidate.telegramMessageId) : null;

  if (messageId !== null) {
    try {
      await deps.api.editMessageText({ chatId, messageId, text: rendered.text, replyMarkup: rendered.replyMarkup });
      return "notified";
    } catch (error) {
      if (isTransient(error)) {
        deps.log?.({ notify: "edit-failed-transient", capability: candidate.id });
        return "error";
      }
      deps.log?.({ notify: "edit-failed-fallback-send", capability: candidate.id });
      // Fall through to a fresh send below — the stored receipt message is gone or can no
      // longer be edited.
    }
  }

  try {
    const sent = await deps.api.sendMessage({ chatId, text: rendered.text, replyMarkup: rendered.replyMarkup });
    if (sent && typeof sent === "object" && typeof sent.message_id === "number") {
      await recordMessageId(deps.pool, candidate.id, sent.message_id);
    }
    return "notified";
  } catch (error) {
    if (isTransient(error)) {
      deps.log?.({ notify: "send-failed-transient", capability: candidate.id });
      return "error";
    }
    deps.log?.({ notify: "send-failed", capability: candidate.id });
    return "skipped";
  }
}

/**
 * Pushes decided/failed Telegram-sourced cards to the owner chat, one tick at a time (see
 * {@link selectCandidates}). A card whose formatting throws is logged and skipped — never
 * allowed to abort the rest of the tick. Returns "notified" if at least one card was pushed
 * this tick (even if others were skipped or errored), "error" if a transient Telegram failure
 * occurred and no card was pushed, or "idle" when there was nothing to do.
 */
export async function runNotifyTick(deps: NotifyTickDeps, signal: AbortSignal): Promise<"idle" | "notified" | "error"> {
  if (signal.aborted) return "idle";
  const candidates = await selectCandidates(deps.pool);
  if (candidates.length === 0) return "idle";

  const scenarios = await loadScenarios(deps.pool);
  const scenarioLabel = new Map(scenarios.map((s) => [s.slug, s.labelZh]));

  let notified = 0;
  let sawError = false;

  for (const candidate of candidates) {
    if (signal.aborted) break;
    let rendered;
    try {
      rendered = formatResult({
        status: statusOf(candidate),
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
        updatedAt: candidate.updatedAt.toISOString(),
        errorCode: candidate.errorCode
      });
    } catch (error) {
      deps.log?.({ notify: "format-failed", capability: candidate.id, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const outcome = await deliver(deps, candidate, rendered);
    if (outcome === "notified") {
      await markNotified(deps.pool, candidate.id);
      notified += 1;
    } else if (outcome === "error") {
      sawError = true;
    }
  }

  deps.log?.({ notify: "done", notified, total: candidates.length });
  if (notified > 0) return "notified";
  if (sawError) return "error";
  return "idle";
}
