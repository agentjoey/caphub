"use client";

import { useState } from "react";
import Link from "next/link";
import type { RecentCapture } from "../lib/captures/captures";
import { RUN_STATE_LABEL, VERDICT_LABEL, errorLabel } from "../lib/library/labels";
import { CapturePreview } from "../components/capability/capture-preview";
import { rerunAction } from "./actions";

const rtf = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

function relativeTime(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / 60000);
  if (Math.abs(diffMinutes) < 60) return rtf.format(diffMinutes, "minute");
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return rtf.format(diffHours, "hour");
  const diffDays = Math.round(diffHours / 24);
  return rtf.format(diffDays, "day");
}

function fallbackTitle(item: RecentCapture): string {
  if (item.title) return item.title;
  if (item.text) return item.text.slice(0, 40);
  if (item.url) {
    try {
      return new URL(item.url).hostname;
    } catch {
      return item.url.slice(0, 40);
    }
  }
  return "截图";
}

export function RecentRow({ item }: { item: RecentCapture }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function rerun() {
    setPending(true);
    setMessage(null);
    try {
      const result = await rerunAction(item.id);
      if (!result.ok) setMessage(result.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="list-row">
      <CapturePreview capture={{ kind: item.kind, objectKey: item.objectKey, text: item.text, url: item.url }} size="thumb" />
      <div>
        <div className="list-row__title">{fallbackTitle(item)}</div>
        <div className="list-row__meta">
          {item.runState && <span className="badge">{RUN_STATE_LABEL[item.runState]}</span>}
          {item.verdict && <span className={`badge badge--${item.verdict}`}>{VERDICT_LABEL[item.verdict]}</span>}
          <span>{relativeTime(item.createdAt)}</span>
        </div>
        {item.runState === "failed" && (
          <div className="list-row__meta">
            <span>{errorLabel(item.errorCode)}</span>
            <button type="button" className="btn" onClick={rerun} disabled={pending}>{pending ? "重跑中…" : "重跑"}</button>
            {message && <span className="inline-error">{message}</span>}
          </div>
        )}
      </div>
      {item.capabilityId && !item.deleted && (
        <Link className="btn" href={`/library/${item.capabilityId}`}>查看</Link>
      )}
    </div>
  );
}
