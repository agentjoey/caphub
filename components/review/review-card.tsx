"use client";

import { useState } from "react";
import { decideAction, editSuggestionAction } from "../../app/actions";
import type { CapabilityType } from "../../lib/analysis/card";
import type { CapabilityDetail, CapabilityRow } from "../../lib/library/queries";
import { AnalysisDetails } from "../capability/analysis-details";
import { CardSummary } from "../capability/card-summary";
import { SuggestionEditor } from "./suggestion-editor";

type State = "idle" | "saving" | "done" | "stale";

export function ReviewCard({ row, detail }: { row: CapabilityRow; detail: CapabilityDetail }) {
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
        setDoneLabel(verdict === "keep" ? "已保留" : "已丢弃");
        setEditing(false);
        setState("done");
        return;
      }
      setMessage(result.message);
      setState(result.reason === "CONFLICT" ? "stale" : "idle");
    } catch {
      setMessage("操作失败，请重试");
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
        setDoneLabel("已保留");
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
      return "操作失败，请重试";
    }
  }

  function toggleEditing() {
    if (busy) return; // collapsing (or opening) mid-save is disabled — avoids setState after unmount
    setEditing((v) => !v);
  }

  return (
    <div className="review-item" data-state={state}>
      <CardSummary row={row} />
      <AnalysisDetails detail={detail} />
      {message && <p className="inline-error review-item__message">{message}</p>}
      {finished ? (
        <p className="review-item__done">{doneLabel}</p>
      ) : (
        <>
          <div className="review-item__actions">
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => decide("keep")}>保留</button>
            <button type="button" className="btn btn--danger" disabled={busy} onClick={() => decide("discard")}>丢弃</button>
            <button type="button" className="btn" disabled={busy} onClick={toggleEditing}>改建议</button>
          </div>
          {editing && (
            <SuggestionEditor
              initialType={row.type}
              initialUsage={row.usage}
              initialTags={row.tags}
              disabled={busy || stale}
              onSave={saveEdit}
            />
          )}
        </>
      )}
    </div>
  );
}
