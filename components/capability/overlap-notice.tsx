"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ignoreOverlapAction, setStatusAction, supersedeOverlapTargetAction } from "../../app/actions";
import type { Overlap } from "../../lib/analysis/card";
import { format, getDict, type Locale } from "../../lib/i18n";
import { useLockToken } from "./use-lock-token";

type State = "idle" | "busy" | "stale";

/**
 * Library-overlap notice shown on a card's detail page when the analysis reason step flagged it
 * as a likely duplicate/upgrade/superseded-by/complement of another kept card. The copy and the
 * available actions both depend on which of the four non-"none" relations was found:
 *
 * - `duplicate` / `upgrade`: this card is the better one to keep, so the action marks the OTHER
 *   card superseded by this one (a separate write that never touches this card's own lock
 *   token, see supersedeOverlapTarget()).
 * - `superseded`: THIS card is the obsolete one, so the action marks THIS card superseded by the
 *   other one instead, via setStatus() using this card's own lock token — offering the
 *   duplicate/upgrade action here would let a human retire the wrong (better) card.
 * - `complement`: the model judged both cards worth keeping, so no supersede action is offered
 *   at all -- only dismiss.
 *
 * Every relation can be dismissed, which clears this card's own `overlap` using this card's lock
 * token like any other writer of this row.
 */
export function OverlapNotice({
  id,
  updatedAt: initialUpdatedAt,
  overlap,
  locale = "zh"
}: {
  id: string;
  updatedAt: string;
  overlap: Overlap;
  locale?: Locale;
}) {
  const dict = getDict(locale).overlapNotice;
  const router = useRouter();
  const [state, setState] = useState<State>("idle");
  const [updatedAt, setUpdatedAt] = useLockToken(initialUpdatedAt);
  const [message, setMessage] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const busy = state === "busy";
  const disabled = busy || state === "stale";

  if (overlap.relation === "none" || dismissed) return null;
  const target = overlap.target ?? "";

  async function markOtherSuperseded() {
    if (disabled) return;
    setState("busy");
    setMessage(null);
    try {
      const result = await supersedeOverlapTargetAction(id);
      if (result.ok) {
        // The server action clears this card's own overlap.relation atomically with marking the
        // other card superseded (same DB transaction), so dismiss immediately here too rather
        // than waiting on router.refresh()'s round trip — same reasoning as ignore() below.
        setDismissed(true);
        setState("idle");
        router.refresh();
        return;
      }
      setMessage(result.message);
      setState("idle");
    } catch {
      setMessage(dict.genericError);
      setState("idle");
    }
  }

  async function markSelfSuperseded() {
    if (disabled) return;
    setState("busy");
    setMessage(null);
    try {
      // `superseded`: this card is the obsolete one, so this writes THIS card's own row (using
      // its own lock token) rather than reusing markOtherSuperseded()'s target-writing action,
      // which would retire the wrong (better) card.
      const result = await setStatusAction(id, updatedAt, "superseded", target, overlap.reason || null);
      if (result.ok) {
        setUpdatedAt(result.updatedAt);
        setDismissed(true);
        setState("idle");
        router.refresh();
        return;
      }
      setMessage(result.message);
      setState(result.reason === "CONFLICT" ? "stale" : "idle");
    } catch {
      setMessage(dict.genericError);
      setState("idle");
    }
  }

  async function ignore() {
    if (disabled) return;
    setState("busy");
    setMessage(null);
    try {
      const result = await ignoreOverlapAction(id, updatedAt);
      if (result.ok) {
        setUpdatedAt(result.updatedAt);
        setDismissed(true);
        setState("idle");
        router.refresh();
        return;
      }
      setMessage(result.message);
      setState(result.reason === "CONFLICT" ? "stale" : "idle");
    } catch {
      setMessage(dict.genericError);
      setState("idle");
    }
  }

  const noticeTemplate = {
    duplicate: dict.noticeDuplicate,
    upgrade: dict.noticeUpgrade,
    superseded: dict.noticeSuperseded,
    complement: dict.noticeComplement
  }[overlap.relation];
  const notice = format(noticeTemplate, { target });

  return (
    <section className="panel overlap-notice">
      <p>{overlap.reason ? `${notice} · ${overlap.reason}` : notice}</p>
      <div className="overlap-notice__buttons">
        {(overlap.relation === "duplicate" || overlap.relation === "upgrade") && (
          <button type="button" className="btn" disabled={disabled} onClick={markOtherSuperseded}>
            {format(dict.markOtherSuperseded, { target })}
          </button>
        )}
        {overlap.relation === "superseded" && (
          <button type="button" className="btn" disabled={disabled} onClick={markSelfSuperseded}>
            {format(dict.markSelfSuperseded, { target })}
          </button>
        )}
        <button type="button" className="btn" disabled={disabled} onClick={ignore}>{dict.ignore}</button>
      </div>
      {message && <p className="inline-error">{message}</p>}
    </section>
  );
}
