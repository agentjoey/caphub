"use client";

import { useState } from "react";
import { formatDateTime } from "../../lib/library/format";
import { format, getDict, type Locale } from "../../lib/i18n";
import { parseYouTubeUrl } from "../../lib/analysis/material/youtube";

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

/**
 * A list/card tile image that swaps itself for a text placeholder when it fails to load — an old
 * capture whose original was purged before thumbnails existed has nothing left to show, and a
 * broken-image box with alt text reads as a bug, not as "no image".
 */
function TileImage({ src, className, alt, fallback }: { src: string; className: string; alt: string; fallback: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className={className}>{fallback}</span>;
  // eslint-disable-next-line @next/next/no-img-element -- images are served by the access-guarded /api/objects proxy
  return <img className={className} src={src} loading="lazy" alt={alt} onError={() => setFailed(true)} />;
}

function FullImage({ originalSrc, thumbSrc, purged, purgeDate, locale }: {
  originalSrc: string | null; thumbSrc: string | null; purged: boolean; purgeDate: string | null; locale: Locale;
}) {
  const dict = getDict(locale).capturePreview;
  // `purged` is the server's own knowledge (retentionPurgedAt) and drives the purge note.
  // `clientFailed` is only a local <img onError>: it swaps to the thumbnail (a broken original
  // may just be a transient load failure) but never asserts a purge the server hasn't confirmed.
  const [clientFailed, setClientFailed] = useState(false);
  const showThumb = purged || clientFailed || !originalSrc;
  if (showThumb) {
    if (!thumbSrc) return <span className="capture-full">{dict.noImage}</span>;
    return (
      <div>
        {/* eslint-disable-next-line @next/next/no-img-element -- images are served by the access-guarded /api/objects proxy */}
        <img className="capture-full" src={thumbSrc} loading="lazy" alt={dict.thumbAlt} />
        {purged && purgeDate && <p className="notice">{format(dict.purgeNote, { date: formatDateTime(purgeDate, locale) })}</p>}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- images are served by the access-guarded /api/objects proxy
    <img className="capture-full" src={originalSrc} loading="lazy" alt={dict.fullAlt} onError={() => setClientFailed(true)} />
  );
}

/**
 * The library card's media strip (2026-10-08): the capture's image (480px thumbnail first) or its
 * YouTube frame, else a typed placeholder (`placeholder`, the card's type label) — never a broken
 * image, never an empty box.
 */
function CardMedia({ capture, placeholder, alt }: { capture: CapturePreviewData; placeholder: string; alt: string }) {
  const empty = <span className="cap-card__media" data-empty="">{placeholder}</span>;
  if (capture.kind === "image") {
    const key = capture.thumbKey ?? capture.objectKey;
    if (!key) return empty;
    return <TileImage src={`/api/objects/${key}`} className="cap-card__media" alt={alt} fallback={placeholder} />;
  }
  const videoId = capture.kind === "url" && capture.url ? parseYouTubeUrl(capture.url) : null;
  if (!videoId) return empty;
  // Decorative, like the list thumbnail: the card's own title names it.
  // eslint-disable-next-line @next/next/no-img-element -- external YouTube thumbnail, not a local asset
  return <img className="cap-card__media" src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`} alt="" loading="lazy" referrerPolicy="no-referrer" />;
}

export function CapturePreview({ capture, size = "thumb", locale = "zh", placeholder }: {
  capture: CapturePreviewData; size?: "thumb" | "full" | "card"; locale?: Locale;
  /** size="card" only: what an image-less card shows instead (its type label). */
  placeholder?: string;
}) {
  const dict = getDict(locale).capturePreview;
  if (size === "card") return <CardMedia capture={capture} placeholder={placeholder ?? dict.noImage} alt={dict.fullAlt} />;
  if (capture.kind === "image") {
    const thumbSrc = capture.thumbKey ? `/api/objects/${capture.thumbKey}` : null;
    const originalSrc = capture.objectKey ? `/api/objects/${capture.objectKey}` : null;
    if (size === "thumb") {
      const src = thumbSrc ?? originalSrc;
      if (!src) return <span className="thumb">{dict.noImage}</span>;
      return <TileImage src={src} className="thumb" alt={dict.fullAlt} fallback={dict.noImage} />;
    }
    if (!originalSrc && !thumbSrc) return <span className="capture-full">{dict.noImage}</span>;
    return (
      <FullImage
        originalSrc={originalSrc}
        thumbSrc={thumbSrc}
        purged={Boolean(capture.retentionPurgedAt)}
        purgeDate={capture.retentionPurgedAt ?? capture.retentionEligibleAt ?? null}
        locale={locale}
      />
    );
  }
  if (capture.kind === "url") {
    const videoId = capture.url ? parseYouTubeUrl(capture.url) : null;
    const thumbImg = videoId && (
      // Decorative: it always sits beside the card title or the video link, so a screen reader
      // gains nothing from it (alt=""). mqdefault (320px) is ample for a 56px thumbnail.
      // eslint-disable-next-line @next/next/no-img-element -- external YouTube thumbnail, not a local asset
      <img className="thumb" src={`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`} alt="" loading="lazy" referrerPolicy="no-referrer" />
    );
    if (size === "thumb") return thumbImg ?? <span className="thumb">{dict.linkThumb}</span>;
    if (!capture.url) return <span className="capture-url">{dict.noLink}</span>;
    const link = <a className="capture-url" href={capture.url} target="_blank" rel="noreferrer">{capture.url}</a>;
    return thumbImg ? <div className="capture-video">{thumbImg}{link}</div> : link;
  }
  if (size === "thumb") return <span className="thumb">{dict.textThumb}</span>;
  const text = capture.text ?? "";
  const truncated = text.length > TEXT_TRUNCATE_LIMIT ? `${text.slice(0, TEXT_TRUNCATE_LIMIT)}…` : text;
  return <blockquote className="capture-text">{truncated}</blockquote>;
}

/**
 * The detail page's right-column capture block (M3.7 task 4): the screenshot is now a
 * provenance artifact, not the headline, so it sits behind a `<details>` closed by default —
 * the library list row's own thumbnail (size="thumb") is untouched by this wrapper.
 */
export function CollapsedCapturePreview({ capture, locale = "zh" }: { capture: CapturePreviewData; locale?: Locale }) {
  const dict = getDict(locale).capturePreview;
  return (
    <details className="capture-collapse">
      <summary>{dict.originalLabel}</summary>
      <CapturePreview capture={capture} size="full" locale={locale} />
    </details>
  );
}
