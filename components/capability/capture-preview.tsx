"use client";

import { useState } from "react";
import { formatDateTime } from "../../lib/library/format";
import { format, getDict, type Locale } from "../../lib/i18n";

const TEXT_PREVIEW_LIMIT = 140;
const TEXT_TRUNCATE_LIMIT = 280;

export interface CapturePreviewData {
  kind: "image" | "text" | "url";
  objectKey: string | null;
  /** Permanent 480px webp preview, keyed by the original's digest; survives the original's 30-day purge. */
  thumbKey?: string | null;
  text: string | null;
  url: string | null;
  /** When the original's 30-day retention window elapses (informational; not itself proof of purge). */
  retentionEligibleAt?: string | null;
  /** Set once the original has actually been deleted by the retention sweep. */
  retentionPurgedAt?: string | null;
}

function FullImage({ originalSrc, thumbSrc, purged, eligibleAt, locale }: {
  originalSrc: string | null; thumbSrc: string | null; purged: boolean; eligibleAt: string | null; locale: Locale;
}) {
  const dict = getDict(locale).capturePreview;
  const [failed, setFailed] = useState(purged || !originalSrc);
  if (failed && thumbSrc) {
    return (
      <div>
        {/* eslint-disable-next-line @next/next/no-img-element -- images are served by the access-guarded /api/objects proxy */}
        <img className="capture-full" src={thumbSrc} loading="lazy" alt={dict.thumbAlt} />
        {eligibleAt && <p className="notice">{format(dict.purgeNote, { date: formatDateTime(eligibleAt, locale) })}</p>}
      </div>
    );
  }
  if (!originalSrc) return <span className="capture-full">{dict.noImage}</span>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- images are served by the access-guarded /api/objects proxy
    <img className="capture-full" src={originalSrc} loading="lazy" alt={dict.fullAlt} onError={() => setFailed(true)} />
  );
}

export function CapturePreview({ capture, size = "thumb", locale = "zh" }: { capture: CapturePreviewData; size?: "thumb" | "full"; locale?: Locale }) {
  const dict = getDict(locale).capturePreview;
  if (capture.kind === "image") {
    const thumbSrc = capture.thumbKey ? `/api/objects/${capture.thumbKey}` : null;
    const originalSrc = capture.objectKey ? `/api/objects/${capture.objectKey}` : null;
    if (size === "thumb") {
      const src = thumbSrc ?? originalSrc;
      if (!src) return <span className="thumb">{dict.noImage}</span>;
      // eslint-disable-next-line @next/next/no-img-element -- images are served by the access-guarded /api/objects proxy
      return <img className="thumb" src={src} loading="lazy" alt={dict.fullAlt} />;
    }
    if (!originalSrc && !thumbSrc) return <span className="capture-full">{dict.noImage}</span>;
    return (
      <FullImage
        originalSrc={originalSrc}
        thumbSrc={thumbSrc}
        purged={Boolean(capture.retentionPurgedAt)}
        eligibleAt={capture.retentionEligibleAt ?? null}
        locale={locale}
      />
    );
  }
  if (capture.kind === "url") {
    if (size === "thumb") return <span className="thumb">{dict.linkThumb}</span>;
    return capture.url
      ? <a className="capture-url" href={capture.url} target="_blank" rel="noreferrer">{capture.url}</a>
      : <span className="capture-url">{dict.noLink}</span>;
  }
  if (size === "thumb") return <span className="thumb">{dict.textThumb}</span>;
  const text = capture.text ?? "";
  const truncated = text.length > TEXT_TRUNCATE_LIMIT ? `${text.slice(0, TEXT_TRUNCATE_LIMIT)}…` : text;
  return <blockquote className="capture-text">{truncated}</blockquote>;
}

/** Excerpt (≤140 chars) of a text capture, for inline display alongside a card's title. */
export function captureTextExcerpt(text: string): string {
  return text.length > TEXT_PREVIEW_LIMIT ? `${text.slice(0, TEXT_PREVIEW_LIMIT)}…` : text;
}
