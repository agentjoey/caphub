"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setStatusAction } from "../../app/actions";
import type { CapabilityStatus } from "../../lib/library/actions";
import { getDict, type Locale } from "../../lib/i18n";
import { useLockToken } from "./use-lock-token";

type State = "idle" | "busy" | "stale";

/**
 * Lifecycle status control for a capability's detail page: set/clear "deprecated", or mark it
 * superseded by another card (picked by serial code, validated server-side). Mirrors
 * ProgressControl/DetailActions' lock handling — a CONFLICT freezes the control until the page
 * is reloaded rather than risking a clobber.
 */
export function StatusControl({
  id,
  updatedAt: initialUpdatedAt,
  status: initialStatus,
  statusNote: initialNote,
  locale = "zh"
}: {
  id: string;
  updatedAt: string;
  status: CapabilityStatus;
  statusNote: string | null;
  locale?: Locale;
}) {
  const dict = getDict(locale).statusControl;
  const router = useRouter();
  const [state, setState] = useState<State>("idle");
  const [updatedAt, setUpdatedAt] = useLockToken(initialUpdatedAt);
  const [status, setStatus] = useState<CapabilityStatus>(initialStatus);
  const [serialInput, setSerialInput] = useState("");
  const [note, setNote] = useState(initialNote ?? "");
  const [message, setMessage] = useState<string | null>(null);

  const busy = state === "busy";
  const disabled = busy || state === "stale";

  async function apply(nextStatus: CapabilityStatus, supersededBy: string | null) {
    if (disabled) return;
    setState("busy");
    setMessage(null);
    // Restoring to 'active' clears the old deprecated/superseded note rather than re-persisting
    // it -- an 有效 card carries no lifecycle note, so a subsequent re-deprecation starts blank
    // instead of silently resurrecting whatever reason was typed the last time it was retired.
    const nextNote = nextStatus === "active" ? null : (note.trim() ? note.trim() : null);
    try {
      const result = await setStatusAction(id, updatedAt, nextStatus, supersededBy, nextNote);
      if (result.ok) {
        setUpdatedAt(result.updatedAt);
        setStatus(nextStatus);
        if (nextStatus === "active") setNote("");
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
    <section className="panel status-control">
      <h2 className="panel-title">{dict.title}</h2>
      <div className="status-control__buttons">
        {status !== "deprecated" && (
          <button type="button" className="btn" disabled={disabled} onClick={() => apply("deprecated", null)}>
            {dict.markDeprecated}
          </button>
        )}
        {status !== "active" && (
          <button type="button" className="btn" disabled={disabled} onClick={() => apply("active", null)}>
            {dict.restoreActive}
          </button>
        )}
      </div>
      <div className="status-control__supersede">
        <label htmlFor={`superseded-by-${id}`}>{dict.markSupersededLabel}</label>
        <input
          id={`superseded-by-${id}`}
          type="text"
          value={serialInput}
          placeholder={dict.serialPlaceholder}
          disabled={disabled}
          onChange={(e) => setSerialInput(e.target.value)}
        />
        <label htmlFor={`status-note-${id}`}>{dict.noteLabel}</label>
        <input
          id={`status-note-${id}`}
          type="text"
          value={note}
          placeholder={dict.notePlaceholder}
          disabled={disabled}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={disabled || !serialInput.trim()}
          onClick={() => apply("superseded", serialInput.trim())}
        >
          {busy ? dict.saving : dict.markSuperseded}
        </button>
      </div>
      {message && <p className="inline-error">{message}</p>}
    </section>
  );
}
