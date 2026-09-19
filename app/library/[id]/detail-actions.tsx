"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { decideAction, editSuggestionAction, rerunAction, reviewAction, softDeleteAction } from "../../actions";
import type { CapabilityType } from "../../../lib/analysis/card";
import { SuggestionEditor } from "../../../components/review/suggestion-editor";

type State = "idle" | "busy" | "stale";

export function DetailActions({
  id,
  captureId,
  updatedAt: initialUpdatedAt,
  verdict,
  type,
  usage,
  tags,
  reviewPending: initialReviewPending
}: {
  id: string;
  captureId: string;
  updatedAt: string;
  verdict: "keep" | "discard" | "pending";
  type: CapabilityType;
  usage: "integrate" | "reference";
  tags: string[];
  reviewPending: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<State>("idle");
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt);
  const [reviewPending, setReviewPending] = useState(initialReviewPending);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const busy = state === "busy";
  const stale = state === "stale";
  const disabled = busy || stale;

  async function decide(nextVerdict: "keep" | "discard") {
    if (disabled) return;
    setState("busy");
    setMessage(null);
    try {
      const result = await decideAction(id, updatedAt, nextVerdict);
      if (result.ok) {
        setUpdatedAt(result.updatedAt);
        setState("idle");
        router.refresh();
        return;
      }
      setMessage(result.message);
      setState(result.reason === "CONFLICT" ? "stale" : "idle");
    } catch {
      setMessage("操作失败，请重试");
      setState("idle");
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
      return "操作失败，请重试";
    }
  }

  async function review() {
    if (disabled || reviewPending) return;
    setState("busy");
    setMessage(null);
    try {
      const result = await reviewAction(id);
      // Intentionally NOT setUpdatedAt(result.updatedAt) on success: requestReview() only sets
      // review_requested_at/review_error, it never touches capabilities.updated_at, and its
      // ActionResult.updatedAt is just the server's current time, not a new lock token. Adopting
      // it as `updatedAt` would desync the optimistic-lock value from the row's real
      // updated_at, so the very next decide()/saveEdit()/confirmDelete() would always CONFLICT.
      if (result.ok) {
        setReviewPending(true);
        setState("idle");
        router.refresh();
        return;
      }
      // A CONFLICT here means "复核已在进行中" (already queued/running) — not a lock conflict
      // on this capability row — so it must not disable the rest of the card's actions.
      setMessage(result.message);
      setState("idle");
    } catch {
      setMessage("操作失败，请重试");
      setState("idle");
    }
  }

  async function rerun() {
    if (disabled) return;
    setState("busy");
    setMessage(null);
    try {
      const result = await rerunAction(captureId);
      // Same reasoning as review(): requestRerun() only inserts an analysis_runs row keyed by
      // captureId, it never touches this capability's updated_at, so its ActionResult.updatedAt
      // (the server's current time) must not overwrite our optimistic-lock token either.
      if (result.ok) {
        setMessage("已加入分析队列，完成后刷新查看");
        setState("idle");
        router.refresh();
        return;
      }
      // A CONFLICT here means "已在排队或分析中" — not a lock conflict on this capability row —
      // so it must not disable the rest of the card's actions.
      setMessage(result.message);
      setState("idle");
    } catch {
      setMessage("操作失败，请重试");
      setState("idle");
    }
  }

  async function confirmDelete() {
    if (disabled) return;
    setState("busy");
    setMessage(null);
    try {
      const result = await softDeleteAction(id, updatedAt);
      if (result.ok) {
        router.push("/library");
        return;
      }
      setMessage(result.message);
      setState(result.reason === "CONFLICT" ? "stale" : "idle");
      setConfirmingDelete(false);
    } catch {
      setMessage("操作失败，请重试");
      setState("idle");
      setConfirmingDelete(false);
    }
  }

  function toggleEditing() {
    if (disabled) return;
    setEditing((v) => !v);
  }

  return (
    <div className="detail-actions">
      <div className="detail-actions__buttons">
        {verdict === "pending" && (
          <>
            <button type="button" className="btn btn--primary" disabled={disabled} onClick={() => decide("keep")}>保留</button>
            <button type="button" className="btn btn--danger" disabled={disabled} onClick={() => decide("discard")}>丢弃</button>
          </>
        )}
        <button type="button" className="btn" disabled={disabled} onClick={toggleEditing}>改建议</button>
        <button type="button" className="btn" disabled={disabled || reviewPending} onClick={review}>
          {reviewPending ? "复核中" : "复核"}
        </button>
        <button type="button" className="btn" disabled={disabled} onClick={rerun}>重跑分析</button>
        {confirmingDelete ? (
          <>
            <button type="button" className="btn btn--danger" disabled={disabled} onClick={confirmDelete}>确认删除</button>
            <button type="button" className="btn" disabled={disabled} onClick={() => setConfirmingDelete(false)}>取消</button>
          </>
        ) : (
          <button type="button" className="btn btn--danger" disabled={disabled} onClick={() => setConfirmingDelete(true)}>删除</button>
        )}
      </div>
      {editing && (
        <SuggestionEditor
          initialType={type}
          initialUsage={usage}
          initialTags={tags}
          disabled={disabled}
          onSave={saveEdit}
        />
      )}
      {message && <p className="inline-error">{message}</p>}
    </div>
  );
}
