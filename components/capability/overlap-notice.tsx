"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ignoreOverlapAction, supersedeOverlapTargetAction } from "../../app/actions";
import type { Overlap } from "../../lib/analysis/card";
import { format, getDict, type Locale } from "../../lib/i18n";
import { useLockToken } from "./use-lock-token";

type State = "idle" | "busy" | "stale";

/**
 * Library-overlap notice shown on a card's detail page when the analysis reason step flagged it
 * as a likely duplicate/upgrade/superseded-by/complement of another kept card. Two actions:
 * accept the finding (marks the OTHER card superseded by this one — a separate write that never
 * touches this card's own lock token, see supersedeOverlapTarget()) or dismiss it (clears this
 * card's own `overlap`, using this card's lock token like any other writer of this row).
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

  return (
    <section className="panel overlap-notice">
      <p>{format(dict.notice, { target, reason: overlap.reason })}</p>
      <div className="overlap-notice__buttons">
        <button type="button" className="btn" disabled={disabled} onClick={markOtherSuperseded}>
          {format(dict.markOtherSuperseded, { target })}
        </button>
        <button type="button" className="btn" disabled={disabled} onClick={ignore}>{dict.ignore}</button>
      </div>
      {message && <p className="inline-error">{message}</p>}
    </section>
  );
}
