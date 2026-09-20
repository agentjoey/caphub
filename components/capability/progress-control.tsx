"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setProgressAction } from "../../app/actions";
import { getDict, type Locale } from "../../lib/i18n";
import { PROGRESS_VALUES, progressLabel, type Progress } from "../../lib/library/labels";
import { useLockToken } from "./use-lock-token";

type State = "idle" | "busy" | "stale";

/**
 * Self-build progress for a `usage = 'reference'` card: pick one of the five states, optionally
 * attach a link, then save. Mirrors DetailActions' lock handling — a CONFLICT means the row moved
 * on under us, so the control freezes until the page is reloaded rather than letting a second save
 * clobber whatever changed; any other failure just shows its message and stays usable.
 */
export function ProgressControl({
  id,
  updatedAt: initialUpdatedAt,
  progress: initialProgress,
  progressLink,
  locale = "zh"
}: {
  id: string;
  updatedAt: string;
  progress: Progress;
  progressLink: string | null;
  locale?: Locale;
}) {
  const dict = getDict(locale).progressControl;
  const router = useRouter();
  const [state, setState] = useState<State>("idle");
  const [updatedAt, setUpdatedAt] = useLockToken(initialUpdatedAt);
  const [progress, setProgress] = useState<Progress>(initialProgress);
  const [link, setLink] = useState(progressLink ?? "");
  const [message, setMessage] = useState<string | null>(null);

  const busy = state === "busy";
  const disabled = busy || state === "stale";

  async function save() {
    if (disabled) return;
    setState("busy");
    setMessage(null);
    try {
      const result = await setProgressAction(id, updatedAt, progress, link);
      if (result.ok) {
        setUpdatedAt(result.updatedAt);
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
    <section className="panel progress-control">
      <h2 className="panel-title">{dict.title}</h2>
      <div className="segmented" role="group" aria-label={dict.stateLegend}>
        {PROGRESS_VALUES.map((value) => (
          <button
            key={value}
            type="button"
            className="btn"
            aria-pressed={progress === value}
            disabled={disabled}
            onClick={() => setProgress(value)}
          >
            {progressLabel(value, locale)}
          </button>
        ))}
      </div>
      <label className="progress-control__link" htmlFor={`progress-link-${id}`}>{dict.linkLabel}</label>
      <input
        id={`progress-link-${id}`}
        type="url"
        inputMode="url"
        value={link}
        placeholder={dict.linkPlaceholder}
        disabled={disabled}
        onChange={(e) => setLink(e.target.value)}
      />
      <p className="progress-control__hint">{dict.linkHint}</p>
      <button type="button" className="btn btn--primary" disabled={disabled} onClick={save}>
        {busy ? dict.saving : dict.save}
      </button>
      {message && <p className="inline-error">{message}</p>}
    </section>
  );
}
