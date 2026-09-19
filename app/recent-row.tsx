"use client";

import { useState } from "react";
import Link from "next/link";
import type { RecentCapture } from "../lib/captures/captures";
import { runStateLabel, verdictLabel, errorLabel } from "../lib/library/labels";
import { getDict, type Locale } from "../lib/i18n";
import { CapturePreview } from "../components/capability/capture-preview";
import { rerunAction } from "./actions";

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
    <div className="list-row">
      <CapturePreview capture={{ kind: item.kind, objectKey: item.objectKey, thumbKey: item.thumbKey, text: item.text, url: item.url }} size="thumb" locale={locale} />
      <div>
        <div className="list-row__title">{fallbackTitle(item, dict.fallbackTitle)}</div>
        <div className="list-row__meta">
          {item.runState && <span className="badge">{runStateLabel(item.runState, locale)}</span>}
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
        <Link className="btn" href={`/library/${item.capabilityId}`}>{dict.view}</Link>
      )}
    </div>
  );
}
