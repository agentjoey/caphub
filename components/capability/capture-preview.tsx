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
      ? <img className="thumb" src={src} loading="lazy" alt="投递的截图" />
      : <img className="capture-full" src={src} loading="lazy" alt="投递的截图" />;
  }
  if (capture.kind === "url") {
    return capture.url
      ? <a className="capture-url" href={capture.url} target="_blank" rel="noreferrer">{capture.url}</a>
      : null;
  }
  const text = capture.text ?? "";
  const limit = size === "thumb" ? TEXT_PREVIEW_LIMIT : TEXT_TRUNCATE_LIMIT;
  const truncated = text.length > limit ? `${text.slice(0, limit)}…` : text;
  return <blockquote className="capture-text">{truncated}</blockquote>;
}
