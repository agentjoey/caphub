"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { decideAction, editSuggestionAction, rerunAction, setProgressAction, softDeleteAction } from "../../app/actions";
import type { CapabilityType } from "../../lib/analysis/card";
import { getDict, type Locale } from "../../lib/i18n";
import { PROGRESS_VALUES, progressLabel, type Progress } from "../../lib/library/labels";
import { useLockToken } from "../capability/use-lock-token";
import { SuggestionEditor } from "../review/suggestion-editor";
import { MainButton } from "./main-button";
import { useTelegram } from "./telegram-webapp";

type State = "idle" | "busy" | "stale";
type RerunState = "idle" | "busy";

/**
 * The mobile counterpart of `app/library/[id]/detail-actions.tsx` + `components/capability/progress-control.tsx`
 * combined into one control, for use from both `/mini/library/[id]` (a single card, all writes)
 * and `/mini/review` (one row per pending card, decide/edit/rerun only — no progress, no delete).
 *
 * Every action that carries the row's optimistic-lock token (decide, edit, progress, delete)
 * shares one `state` machine and freezes (`stale`) on CONFLICT instead of retrying with the old
 * token — same discipline as ProgressControl/DetailActions. `rerun` does not carry that token
 * (its CONFLICT just means "already queued/running"), so it gets its own independent state and
 * never freezes the rest of the card.
 *
 * In-page buttons cover every action so the card works standalone outside Telegram too; on top
 * of that, at most one of them — the card's current primary action — is also mirrored onto
 * Telegram's native MainButton (see `primaryAction` below). MainButton itself no-ops outside
 * Telegram (see `getTelegramWebApp`), so mounting it unconditionally here is safe.
 */
export function MiniActions({
  id,
  captureId,
  updatedAt: initialUpdatedAt,
  verdict: initialVerdict,
  type,
  usage,
  tags,
  progress: initialProgress = null,
  progressLink: initialProgressLink = null,
  allowDelete = false,
  enableMainButton = true,
  locale = "zh"
}: {
  id: string;
  captureId: string;
  updatedAt: string;
  verdict: "keep" | "discard" | "pending";
  type: CapabilityType;
  usage: "integrate" | "reference";
  tags: string[];
  /** Self-build progress; only meaningful for a kept `usage='reference'` card. `null` on the
   * review page (verdict is always 'pending' there, so progress does not apply yet). */
  progress?: Progress | null;
  progressLink?: string | null;
  /** Whether the delete control renders — the review page does not offer it (matches desktop's
   * ReviewCard), only the detail page does. */
  allowDelete?: boolean;
  /** Whether this instance may bind Telegram's native MainButton at all. The detail page shows
   * exactly one card, so its MainButton unambiguously represents that card's primary action; the
   * review page renders up to PAGE_SIZE cards at once, where a single global MainButton could
   * only ever "belong" to one of them — so it passes `false` and keeps every action in-page. */
  enableMainButton?: boolean;
  locale?: Locale;
}) {
  const dict = getDict(locale);
  const router = useRouter();
  const { haptic } = useTelegram();

  const [state, setState] = useState<State>("idle");
  const [updatedAt, setUpdatedAt] = useLockToken(initialUpdatedAt);
  const [verdict, setVerdict] = useState(initialVerdict);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [progress, setProgress] = useState<Progress>(initialProgress ?? "todo");
  const [progressLink, setProgressLink] = useState(initialProgressLink ?? "");
  const [message, setMessage] = useState<string | null>(null);

  const [rerunState, setRerunState] = useState<RerunState>("idle");
  const [rerunMessage, setRerunMessage] = useState<string | null>(null);

  const locked = state !== "idle";
  const hasProgress = initialProgress !== null;

  async function decide(nextVerdict: "keep" | "discard") {
    if (locked) return;
    setState("busy");
    setMessage(null);
    try {
      const result = await decideAction(id, updatedAt, nextVerdict);
      if (result.ok) {
        setUpdatedAt(result.updatedAt);
        setVerdict(nextVerdict);
        setState("idle");
        haptic("success");
        router.refresh();
        return;
      }
      setMessage(result.message);
      setState(result.reason === "CONFLICT" ? "stale" : "idle");
      haptic("warning");
    } catch {
      setMessage(dict.detailActions.genericError);
      setState("idle");
      haptic("warning");
    }
  }

  async function saveEdit(nextType: CapabilityType, nextUsage: "integrate" | "reference", nextTags: string[]): Promise<string | null> {
    setState("busy");
    setMessage(null);
    try {
      const result = await editSuggestionAction(id, updatedAt, nextType, nextUsage, nextTags);
      if (result.ok) {
        setUpdatedAt(result.updatedAt);
        setEditing(false);
        setState("idle");
        router.refresh();
        return null;
      }
      if (result.reason === "CONFLICT") {
        setMessage(result.message);
        setState("stale");
        return null;
      }
      setState("idle");
      return result.message;
    } catch {
      setState("idle");
      return dict.detailActions.genericError;
    }
  }

  async function startBuilding() {
    if (locked) return;
    setState("busy");
    setMessage(null);
    try {
      const result = await setProgressAction(id, updatedAt, "building", progressLink.trim() || null);
      if (result.ok) {
        setUpdatedAt(result.updatedAt);
        setProgress("building");
        setState("idle");
        haptic("success");
        router.refresh();
        return;
      }
      setMessage(result.message);
      setState(result.reason === "CONFLICT" ? "stale" : "idle");
      haptic("warning");
    } catch {
      setMessage(dict.progressControl.genericError);
      setState("idle");
      haptic("warning");
    }
  }

  async function saveProgress() {
    if (locked) return;
    setState("busy");
    setMessage(null);
    try {
      const result = await setProgressAction(id, updatedAt, progress, progressLink.trim() || null);
      if (result.ok) {
        setUpdatedAt(result.updatedAt);
        setState("idle");
        haptic("success");
        router.refresh();
        return;
      }
      setMessage(result.message);
      setState(result.reason === "CONFLICT" ? "stale" : "idle");
      haptic("warning");
    } catch {
      setMessage(dict.progressControl.genericError);
      setState("idle");
      haptic("warning");
    }
  }

  async function rerun() {
    if (rerunState === "busy") return;
    setRerunState("busy");
    setRerunMessage(null);
    try {
      const result = await rerunAction(captureId);
      if (result.ok) {
        setRerunMessage(dict.detailActions.rerunQueued);
        setRerunState("idle");
        router.refresh();
        return;
      }
      // A CONFLICT here means "already queued/running" — not a lock conflict on this row — so it
      // must not freeze the rest of the card's actions (same reasoning as desktop DetailActions).
      setRerunMessage(result.message);
      setRerunState("idle");
    } catch {
      setRerunMessage(dict.detailActions.genericError);
      setRerunState("idle");
    }
  }

  async function confirmDelete() {
    if (locked) return;
    setState("busy");
    setMessage(null);
    try {
      const result = await softDeleteAction(id, updatedAt);
      if (result.ok) {
        router.push("/mini");
        return;
      }
      setMessage(result.message);
      setState(result.reason === "CONFLICT" ? "stale" : "idle");
      setConfirmingDelete(false);
    } catch {
      setMessage(dict.detailActions.genericError);
      setState("idle");
      setConfirmingDelete(false);
    }
  }

  // No `verdict === 'pending'` branch here: a pending card only ever renders on /mini/review,
  // which always passes `enableMainButton={false}` (a multi-row queue has no single card for one
  // global MainButton to represent — see that prop's doc comment), and /mini/library/[id]
  // redirects pending cards away before this component ever mounts for one. Binding MainButton
  // to 保留 here would be dead code every real caller disables.
  const primaryAction =
    hasProgress && usage === "reference" && progress === "todo"
      ? { text: dict.progressControl.startBuilding, onClick: startBuilding }
      : null;

  return (
    <div className="mini-actions">
      {enableMainButton && primaryAction && <MainButton text={primaryAction.text} onClick={primaryAction.onClick} disabled={locked} />}
      <div className="mini-actions__buttons">
        {verdict === "pending" && (
          <>
            <button type="button" className="btn btn--primary" disabled={locked} onClick={() => decide("keep")}>{dict.detailActions.keep}</button>
            <button type="button" className="btn btn--danger" disabled={locked} onClick={() => decide("discard")}>{dict.detailActions.discard}</button>
          </>
        )}
        <button type="button" className="btn" disabled={locked} onClick={() => setEditing((v) => !v)}>{dict.detailActions.editSuggestion}</button>
        <button type="button" className="btn" disabled={rerunState === "busy"} onClick={rerun}>{dict.detailActions.rerun}</button>
        {allowDelete && (
          confirmingDelete ? (
            <>
              <button type="button" className="btn btn--danger" disabled={locked} onClick={confirmDelete}>{dict.detailActions.confirmDelete}</button>
              <button type="button" className="btn" disabled={locked} onClick={() => setConfirmingDelete(false)}>{dict.detailActions.cancel}</button>
            </>
          ) : (
            <button type="button" className="btn btn--danger" disabled={locked} onClick={() => setConfirmingDelete(true)}>{dict.detailActions.delete}</button>
          )
        )}
      </div>
      {editing && (
        <SuggestionEditor
          initialType={type}
          initialUsage={usage}
          initialTags={tags}
          disabled={locked}
          onSave={saveEdit}
          locale={locale}
        />
      )}
      {message && <p className="inline-error">{message}</p>}
      {rerunMessage && <p className="inline-error">{rerunMessage}</p>}

      {hasProgress && usage === "reference" && (
        <section className="panel progress-control">
          <h2 className="panel-title">{dict.progressControl.title}</h2>
          <div className="segmented" role="group" aria-label={dict.progressControl.stateLegend}>
            {PROGRESS_VALUES.map((value) => (
              <button
                key={value}
                type="button"
                className="btn"
                aria-pressed={progress === value}
                disabled={locked}
                onClick={() => setProgress(value)}
              >
                {progressLabel(value, locale)}
              </button>
            ))}
          </div>
          <label className="progress-control__link" htmlFor={`mini-progress-link-${id}`}>{dict.progressControl.linkLabel}</label>
          <input
            id={`mini-progress-link-${id}`}
            type="url"
            inputMode="url"
            value={progressLink}
            placeholder={dict.progressControl.linkPlaceholder}
            disabled={locked}
            onChange={(e) => setProgressLink(e.target.value)}
          />
          <p className="progress-control__hint">{dict.progressControl.linkHint}</p>
          <button type="button" className="btn btn--primary" disabled={locked} onClick={saveProgress}>
            {state === "busy" ? dict.progressControl.saving : dict.progressControl.save}
          </button>
        </section>
      )}
    </div>
  );
}
