"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { RecentCapture } from "../../lib/captures/captures";
import { runStateLabel, verdictLabel, errorLabel } from "../../lib/library/labels";
import { format, getDict, type Locale } from "../../lib/i18n";
import { pipelineStages } from "../../lib/captures/stage";
import { CapturePreview } from "../../components/capability/capture-preview";
import { rerunAction } from "../actions";

/** How long a just-finished row keeps its "arrived" highlight (the CSS fade runs a little shorter). */
const ARRIVED_MS = 1600;

function StageList({ item, locale }: { item: RecentCapture; locale: Locale }) {
  const dict = getDict(locale).recentRow;
  const { stages, current } = pipelineStages(item.kind, item.url, item.okSteps);
  const at = stages.indexOf(current);
  return (
    <ol className="stages" aria-label={format(dict.stagesAria, { n: at + 1, total: stages.length, stage: dict.stages[current] })}>
      {stages.map((stage, index) => (
        <li key={stage} data-state={index < at ? "done" : index === at ? "current" : "todo"}>
          {index === at && <span className="live-dot" aria-hidden="true" />}
          {dict.stages[stage]}
        </li>
      ))}
    </ol>
  );
}

function fallbackTitle(item: RecentCapture, fallback: string): string {
  if (item.title) return item.title;
  if (item.text) return item.text.slice(0, 40);
  if (item.url) {
    try {
      return new URL(item.url).hostname;
    } catch {
      return item.url.slice(0, 40);
    }
  }
  return fallback;
}

export function RecentRow({ item, relativeTime, locale = "zh" }: { item: RecentCapture; relativeTime: string; locale?: Locale }) {
  const dict = getDict(locale).recentRow;
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [arrived, setArrived] = useState(false);
  const previousState = useRef(item.runState);

  // A row the page watched finish (queued/running → done, via PipelineWatcher's refresh) flashes
  // once; a row that was already done on first render never does.
  useEffect(() => {
    const was = previousState.current;
    previousState.current = item.runState;
    if (item.runState !== "done" || (was !== "queued" && was !== "running")) return;
    setArrived(true);
    const timer = window.setTimeout(() => setArrived(false), ARRIVED_MS);
    return () => window.clearTimeout(timer);
  }, [item.runState]);

  async function rerun() {
    setPending(true);
    setMessage(null);
    try {
      const result = await rerunAction(item.id);
      if (!result.ok) setMessage(result.message);
    } catch {
      setMessage(dict.rerunFailed);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="list-row" data-arrived={arrived ? "" : undefined}>
      <CapturePreview capture={{ kind: item.kind, objectKey: item.objectKey, thumbKey: item.thumbKey, text: item.text, url: item.url }} size="thumb" locale={locale} />
      <div>
        <div className="list-row__title">{fallbackTitle(item, dict.fallbackTitle)}</div>
        <div className="list-row__meta">
          {item.runState && (
            <span className="badge">
              {item.runState === "queued" && <span className="live-dot" aria-hidden="true" />}
              {runStateLabel(item.runState, locale)}
            </span>
          )}
          {item.runState === "running" && <StageList item={item} locale={locale} />}
          {item.deleted ? (
            <span className="badge badge--discard">{dict.deletedBadge}</span>
          ) : (
            item.verdict && <span className={`badge badge--${item.verdict}`}>{verdictLabel(item.verdict, locale)}</span>
          )}
          <span>{relativeTime}</span>
        </div>
        {item.runState === "failed" && (
          <div className="list-row__meta">
            <span>{errorLabel(item.errorCode, locale)}</span>
            <button type="button" className="btn" onClick={rerun} disabled={pending}>{pending ? dict.rerunning : dict.rerun}</button>
            {message && <span className="inline-error">{message}</span>}
          </div>
        )}
      </div>
      {item.capabilityId && !item.deleted && (
        <Link
          className="btn"
          href={item.verdict === "pending" ? `/review#${item.capabilityId}` : `/library/${item.capabilityId}`}
        >
          {dict.view}
        </Link>
      )}
    </div>
  );
}
