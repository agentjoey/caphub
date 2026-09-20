import type { Pool } from "pg";
import { loadScenarios } from "../analysis/scenarios";
import type { Pipeline } from "../config";
import { getDict } from "../i18n";
import { decide, requestRerun } from "../library/actions";
import type { InlineKeyboardMarkup, TelegramApi } from "./api";
import { buildFormatInput, loadCandidateById, type Candidate } from "./notify";
import { formatResult } from "./format";
import type { ClassifiedUpdate, DecisionAction } from "./router";

/** The `{kind: "callback", ...}` branch of {@link ClassifiedUpdate} — what `handleCallback` acts on. */
export type CallbackDecoded = Extract<ClassifiedUpdate, { kind: "callback" }>;

export interface HandleCallbackDeps {
  pool: Pool;
  api: Pick<TelegramApi, "answerCallbackQuery" | "editMessageText">;
  ownerChatId: number | string;
  /** Pipeline a rerun is queued under (`config.pipeline`) — `requestRerun` needs it, `decide` does not. */
  pipeline: Pipeline;
  log?: (o: Record<string, unknown>) => void;
}

export type CallbackOutcome =
  | { outcome: "decided"; action: DecisionAction; capabilityId: string }
  | { outcome: "conflict"; capabilityId: string }
  | { outcome: "rejected"; reason: "not-owner" | "not-found" | "object-gone" | "already-queued" | "invalid" | "unknown-action"; capabilityId?: string }
  | { outcome: "failed"; reason: string; capabilityId?: string };

const dict = getDict("zh").actions;

const TOAST = {
  keep: "已保留",
  discard: "已丢弃",
  rerun: "已重新排队",
  // Shown when the requeue itself succeeded but clearing notified_at did not (see
  // clearNotifiedAtWithRetry) — the rerun is still running, but the notify tick won't re-push
  // its result (notified_at is still set), so the user must check the web UI instead of waiting
  // on a Telegram message that may never arrive.
  rerunNoAutoPush: "已重新排队，但结果可能不会自动推送，请去 web 查看",
  notOwner: "无权操作"
} as const;

const REQUEUE_TEXT = "已重新排队，分析中…";

/**
 * Telegram keeps an existing inline keyboard when `reply_markup` is omitted from an
 * `editMessageText` call (see api.ts) — an *explicit* empty keyboard is required to actually
 * remove the 保留/丢弃/重跑分析 buttons.
 */
const NO_BUTTONS: InlineKeyboardMarkup = { inline_keyboard: [] };

async function loadScenarioLabels(pool: Pool): Promise<Map<string, string>> {
  const scenarios = await loadScenarios(pool);
  return new Map(scenarios.map((s) => [s.slug, s.labelZh]));
}

/** Edits the Telegram message to a candidate's current rendered state, with buttons stripped (buttons are simply never re-sent). */
async function editToCurrentState(deps: HandleCallbackDeps, cb: CallbackDecoded, candidate: Candidate, signal?: AbortSignal): Promise<void> {
  const scenarioLabel = await loadScenarioLabels(deps.pool);
  const rendered = formatResult(buildFormatInput(candidate, scenarioLabel));
  await deps.api.editMessageText({ chatId: cb.chatId, messageId: cb.messageId, text: rendered.text, replyMarkup: NO_BUTTONS, signal });
}

async function clearNotifiedAt(pool: Pool, capabilityId: string): Promise<void> {
  await pool.query("UPDATE caphub_v2.capabilities SET notified_at = NULL WHERE id = $1", [capabilityId]);
}

/**
 * `clearNotifiedAt`, retried once on failure. Unlike {@link runSideEffect}'s other callers, a
 * failure here is not cosmetic: if `notified_at` is never cleared, the rerun's eventual result
 * is silently never pushed (selectCandidates in notify.ts only picks up unnotified cards), so
 * the Telegram message is stuck on "已重新排队，分析中…" forever with no further sign of life.
 * Returns whether it ultimately succeeded so the caller can fall back to a "check the web" toast
 * instead of claiming a clean requeue.
 */
async function clearNotifiedAtWithRetry(deps: HandleCallbackDeps, capabilityId: string): Promise<boolean> {
  try {
    await clearNotifiedAt(deps.pool, capabilityId);
    return true;
  } catch (error) {
    deps.log?.({ decide: "clear-notified-at-failed-retrying", capabilityId, error: error instanceof Error ? error.message : String(error) });
  }
  try {
    await clearNotifiedAt(deps.pool, capabilityId);
    return true;
  } catch (error) {
    deps.log?.({ decide: "clear-notified-at-failed", capabilityId, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * Runs a post-decision side effect (re-render the message, clear `notified_at`) that must
 * never turn a successful decision into a "failed" outcome or trigger a second
 * `answerCallbackQuery` call — the toast was already sent by the time this runs.
 */
async function runSideEffect(deps: HandleCallbackDeps, cb: CallbackDecoded, label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    deps.log?.({ decide: label, capabilityId: cb.capabilityId, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Handles one decoded callback query (保留/丢弃/重跑分析 button press): applies the decision via
 * the shared `decide`/`requestRerun` actions, answers the Telegram callback with a short toast,
 * and edits the original message to match. Never throws — this runs in the worker's poll loop,
 * where an uncaught error would otherwise abort the whole tick.
 */
export async function handleCallback(deps: HandleCallbackDeps, cb: CallbackDecoded, signal?: AbortSignal): Promise<CallbackOutcome> {
  try {
    if (String(cb.chatId) !== String(deps.ownerChatId)) {
      await safeAnswer(deps, cb, TOAST.notOwner, signal);
      return { outcome: "rejected", reason: "not-owner" };
    }

    // A "rerun-capture" button (see router.ts's DecisionAction) carries a capture id, not a
    // capability id — there is no capability row to load yet, so this must branch before
    // loadCandidateById below (which would otherwise report a spurious "not-found").
    if (cb.action === "rerun-capture") {
      return await handleRerunCapture(deps, cb, signal);
    }

    const candidate = await loadCandidateById(deps.pool, cb.capabilityId);
    if (!candidate) {
      await safeAnswer(deps, cb, dict.cardNotFound, signal);
      return { outcome: "rejected", reason: "not-found", capabilityId: cb.capabilityId };
    }

    if (candidate.updatedAt.toISOString() !== cb.updatedAt) {
      await safeAnswer(deps, cb, dict.conflict, signal);
      await runSideEffect(deps, cb, "render-stale-conflict-failed", () => editToCurrentState(deps, cb, candidate, signal));
      return { outcome: "conflict", capabilityId: cb.capabilityId };
    }

    switch (cb.action) {
      case "keep":
      case "discard":
        return await handleDecide(deps, cb, signal);
      case "rerun":
        return await handleRerun(deps, cb, candidate, signal);
      default: {
        // Unreachable given DecisionAction's type, but decodeDecision's output isn't
        // re-validated here — kept as a defensive, total branch.
        await safeAnswer(deps, cb, "未知操作", signal);
        return { outcome: "rejected", reason: "unknown-action", capabilityId: cb.capabilityId };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.({ decide: "handle-callback-failed", capabilityId: cb.capabilityId, error: message });
    await safeAnswer(deps, cb, undefined, signal);
    return { outcome: "failed", reason: message, capabilityId: cb.capabilityId };
  }
}

/** `answerCallbackQuery` best-effort: a failure here must not throw out of `handleCallback`. */
async function safeAnswer(deps: HandleCallbackDeps, cb: CallbackDecoded, text: string | undefined, signal?: AbortSignal): Promise<void> {
  try {
    await deps.api.answerCallbackQuery({ callbackQueryId: cb.callbackId, ...(text !== undefined ? { text } : {}), signal });
  } catch (error) {
    deps.log?.({ decide: "answer-callback-failed", capabilityId: cb.capabilityId, error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleDecide(deps: HandleCallbackDeps, cb: CallbackDecoded, signal?: AbortSignal): Promise<CallbackOutcome> {
  const verdict = cb.action as "keep" | "discard";
  const result = await decide(deps.pool, { id: cb.capabilityId, expectedUpdatedAt: cb.updatedAt, verdict }, "zh");

  if (result.ok) {
    await safeAnswer(deps, cb, TOAST[verdict], signal);
    await runSideEffect(deps, cb, "render-decided-failed", async () => {
      const fresh = await loadCandidateById(deps.pool, cb.capabilityId);
      if (fresh) await editToCurrentState(deps, cb, fresh, signal);
    });
    return { outcome: "decided", action: verdict, capabilityId: cb.capabilityId };
  }

  await safeAnswer(deps, cb, result.message, signal);
  if (result.reason === "CONFLICT") {
    await runSideEffect(deps, cb, "render-conflict-failed", async () => {
      const current = await loadCandidateById(deps.pool, cb.capabilityId);
      if (current) await editToCurrentState(deps, cb, current, signal);
    });
    return { outcome: "conflict", capabilityId: cb.capabilityId };
  }
  if (result.reason === "NOT_FOUND") {
    return { outcome: "rejected", reason: "not-found", capabilityId: cb.capabilityId };
  }
  return { outcome: "rejected", reason: "invalid", capabilityId: cb.capabilityId };
}

async function handleRerun(deps: HandleCallbackDeps, cb: CallbackDecoded, candidate: Candidate, signal?: AbortSignal): Promise<CallbackOutcome> {
  const result = await requestRerun(deps.pool, { captureId: candidate.captureId, pipeline: deps.pipeline }, "zh");

  if (result.ok) {
    // Clear notified_at (with one retry) *before* answering, so the toast can honestly say
    // whether the eventual result will be auto-pushed — see clearNotifiedAtWithRetry.
    const cleared = await clearNotifiedAtWithRetry(deps, cb.capabilityId);
    await runSideEffect(deps, cb, "requeue-edit-failed", () =>
      deps.api.editMessageText({ chatId: cb.chatId, messageId: cb.messageId, text: REQUEUE_TEXT, replyMarkup: NO_BUTTONS, signal }).then(() => undefined)
    );
    if (!cleared) {
      await safeAnswer(deps, cb, TOAST.rerunNoAutoPush, signal);
      return { outcome: "failed", reason: "clear-notified-at-failed", capabilityId: cb.capabilityId };
    }
    await safeAnswer(deps, cb, TOAST.rerun, signal);
    return { outcome: "decided", action: "rerun", capabilityId: cb.capabilityId };
  }

  await safeAnswer(deps, cb, result.message, signal);
  if (result.reason === "OBJECT_GONE") return { outcome: "rejected", reason: "object-gone", capabilityId: cb.capabilityId };
  if (result.reason === "CONFLICT") return { outcome: "rejected", reason: "already-queued", capabilityId: cb.capabilityId };
  if (result.reason === "NOT_FOUND") return { outcome: "rejected", reason: "not-found", capabilityId: cb.capabilityId };
  return { outcome: "rejected", reason: "invalid", capabilityId: cb.capabilityId };
}

/**
 * Handles a `"rerun-capture"` button press (see router.ts's `DecisionAction`): `cb.capabilityId`
 * is actually a capture id here, so unlike {@link handleRerun} this never loads a `Candidate` —
 * there is no capability row yet. `requestRerun` itself guards against a concurrent re-queue
 * (its partial unique index), so there is no optimistic-lock check to perform here either.
 */
async function handleRerunCapture(deps: HandleCallbackDeps, cb: CallbackDecoded, signal?: AbortSignal): Promise<CallbackOutcome> {
  const result = await requestRerun(deps.pool, { captureId: cb.capabilityId, pipeline: deps.pipeline }, "zh");

  if (result.ok) {
    await safeAnswer(deps, cb, TOAST.rerun, signal);
    await runSideEffect(deps, cb, "requeue-capture-edit-failed", () =>
      deps.api.editMessageText({ chatId: cb.chatId, messageId: cb.messageId, text: REQUEUE_TEXT, replyMarkup: NO_BUTTONS, signal }).then(() => undefined)
    );
    return { outcome: "decided", action: "rerun-capture", capabilityId: cb.capabilityId };
  }

  await safeAnswer(deps, cb, result.message, signal);
  if (result.reason === "OBJECT_GONE") return { outcome: "rejected", reason: "object-gone", capabilityId: cb.capabilityId };
  if (result.reason === "CONFLICT") return { outcome: "rejected", reason: "already-queued", capabilityId: cb.capabilityId };
  if (result.reason === "NOT_FOUND") return { outcome: "rejected", reason: "not-found", capabilityId: cb.capabilityId };
  return { outcome: "rejected", reason: "invalid", capabilityId: cb.capabilityId };
}
