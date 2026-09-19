const TEXT_PREVIEW_LIMIT = 140;
const TEXT_TRUNCATE_LIMIT = 280;

export interface CapturePreviewData {
  kind: "image" | "text" | "url";
  objectKey: string | null;
  text: string | null;
  url: string | null;
}

export function CapturePreview({ capture, size = "thumb" }: { capture: CapturePreviewData; size?: "thumb" | "full" }) {
  if (capture.kind === "image") {
    if (!capture.objectKey) return <span className={size === "thumb" ? "thumb" : "capture-full"}>无图</span>;
    const src = `/api/objects/${capture.objectKey}`;
    return size === "thumb"
      // eslint-disable-next-line @next/next/no-img-element -- images are served by the access-guarded /api/objects proxy
      ? <img className="thumb" src={src} loading="lazy" alt="投递的截图" />
      // eslint-disable-next-line @next/next/no-img-element -- images are served by the access-guarded /api/objects proxy
      : <img className="capture-full" src={src} loading="lazy" alt="投递的截图" />;
  }
  if (capture.kind === "url") {
    if (size === "thumb") return <span className="thumb">链接</span>;
    return capture.url
      ? <a className="capture-url" href={capture.url} target="_blank" rel="noreferrer">{capture.url}</a>
      : <span className="capture-url">无链接</span>;
  }
  if (size === "thumb") return <span className="thumb">文字</span>;
  const text = capture.text ?? "";
  const truncated = text.length > TEXT_TRUNCATE_LIMIT ? `${text.slice(0, TEXT_TRUNCATE_LIMIT)}…` : text;
  return <blockquote className="capture-text">{truncated}</blockquote>;
}

/** Excerpt (≤140 chars) of a text capture, for inline display alongside a card's title. */
export function captureTextExcerpt(text: string): string {
  return text.length > TEXT_PREVIEW_LIMIT ? `${text.slice(0, TEXT_PREVIEW_LIMIT)}…` : text;
}
