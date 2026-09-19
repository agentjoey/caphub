"use client";

import { useState } from "react";
import { decideAction, editSuggestionAction, rerunAction } from "../../app/actions";
import type { CapabilityType } from "../../lib/analysis/card";
import type { CapabilityDetail, CapabilityRow } from "../../lib/library/queries";
import { getDict, type Locale } from "../../lib/i18n";
import { AnalysisDetails } from "../capability/analysis-details";
import { CardSummary } from "../capability/card-summary";
import { SuggestionEditor } from "./suggestion-editor";

type State = "idle" | "saving" | "done" | "stale";

export function ReviewCard({ row, detail, locale = "zh" }: { row: CapabilityRow; detail: CapabilityDetail; locale?: Locale }) {
  const dict = getDict(locale);
  const [state, setState] = useState<State>("idle");
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(row.updatedAt);
  const [message, setMessage] = useState<string | null>(null);
  const [doneLabel, setDoneLabel] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  // Single busy/in-flight flag, shared by decide() and saveEdit(): while either request is
  // pending, all of 保留/丢弃/改建议 and the open SuggestionEditor must be disabled — otherwise
  // a decide() click during a pending edit save could fire a second, conflicting request against
  // the same lock token.
  const busy = state === "saving";
  const stale = state === "stale";
  const finished = state === "done";

  async function decide(verdict: "keep" | "discard") {
    if (busy) return;
    setState("saving");
    setMessage(null);
    try {
      const result = await decideAction(row.id, expectedUpdatedAt, verdict);
      if (result.ok) {
        setExpectedUpdatedAt(result.updatedAt);
        setDoneLabel(verdict === "keep" ? dict.review.doneKeep : dict.review.doneDiscard);
        setEditing(false);
        setState("done");
        return;
      }
      setMessage(result.message);
      setState(result.reason === "CONFLICT" ? "stale" : "idle");
    } catch {
      setMessage(dict.detailActions.genericError);
      setState("idle");
    }
  }

  async function saveEdit(type: CapabilityType, usage: "integrate" | "reference", tags: string[]): Promise<string | null> {
    setState("saving");
    setMessage(null);
    try {
      const result = await editSuggestionAction(row.id, expectedUpdatedAt, type, usage, tags);
      if (result.ok) {
        setExpectedUpdatedAt(result.updatedAt);
        setDoneLabel(dict.review.doneKeep);
        setEditing(false);
        setState("done");
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

  async function rerun() {
    if (busy) return;
    setState("saving");
    setMessage(null);
    try {
      const result = await rerunAction(row.captureId);
      // Same reasoning as DetailActions' rerun(): requestRerun() only inserts an
      // analysis_runs row keyed by captureId, it never touches this capability's updated_at,
      // and a CONFLICT here means "已在排队或分析中" (already queued/running) — not a lock
      // conflict on this row — so it must not go stale.
      if (result.ok) {
        setMessage(dict.detailActions.rerunQueued);
        setState("idle");
        return;
      }
      setMessage(result.message);
      setState("idle");
    } catch {
      setMessage(dict.detailActions.genericError);
      setState("idle");
    }
  }

  function toggleEditing() {
    if (busy) return; // collapsing (or opening) mid-save is disabled — avoids setState after unmount
    setEditing((v) => !v);
  }

  return (
    <div className="review-item" data-state={state} id={row.id}>
      <CardSummary row={row} locale={locale} />
      <AnalysisDetails detail={detail} locale={locale} />
      {message && <p className="inline-error review-item__message">{message}</p>}
      {finished ? (
        <p className="review-item__done">{doneLabel}</p>
      ) : (
        <>
          <div className="review-item__actions">
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => decide("keep")}>{dict.detailActions.keep}</button>
            <button type="button" className="btn btn--danger" disabled={busy} onClick={() => decide("discard")}>{dict.detailActions.discard}</button>
            <button type="button" className="btn" disabled={busy} onClick={toggleEditing}>{dict.detailActions.editSuggestion}</button>
            <button type="button" className="btn" disabled={busy} onClick={rerun}>{dict.detailActions.rerun}</button>
          </div>
          {editing && (
            <SuggestionEditor
              initialType={row.type}
              initialUsage={row.usage}
              initialTags={row.tags}
              disabled={busy || stale}
              onSave={saveEdit}
              locale={locale}
            />
          )}
        </>
      )}
    </div>
  );
}
