"use client";

import { useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

const ACCEPTED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KiB` : `${Number((bytes / 1024 / 1024).toFixed(2))} MiB`;
}

export function CaptureForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateCapabilityId, setDuplicateCapabilityId] = useState<string | null>(null);
  const [duplicateNotice, setDuplicateNotice] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function chooseFile(candidate: File | undefined | null) {
    if (!candidate) return;
    if (!ACCEPTED_MIME.has(candidate.type)) {
      setError("仅支持 PNG、JPEG 或 WebP 图片。");
      return;
    }
    setError(null);
    setFile(candidate);
  }

  function clearFile() {
    setFile(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    chooseFile(event.dataTransfer.files[0]);
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement | HTMLTextAreaElement>) {
    const pastedFile = Array.from(event.clipboardData.files).find((candidate) => candidate.type.startsWith("image/"));
    if (pastedFile) {
      event.preventDefault();
      chooseFile(pastedFile);
      return;
    }
    const pastedText = event.clipboardData.getData("text");
    if (pastedText) setText((current) => current || pastedText);
  }

  const bothFilled = sourceUrl.trim().length > 0 && text.trim().length > 0;
  const hasContent = !!file || sourceUrl.trim().length > 0 || text.trim().length > 0;
  const linkInvalid = !file && sourceUrl.trim().length > 0 && !sourceUrl.trim().startsWith("https://");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !hasContent || (!file && bothFilled) || linkInvalid) return;
    setPending(true);
    setError(null);
    setDuplicateNotice(false);
    setDuplicateCapabilityId(null);
    try {
      const body = new FormData();
      if (file) body.set("file", file);
      else body.set("text", sourceUrl.trim() || text.trim());
      const response = await fetch("/api/captures", { method: "POST", body });
      const payload = (await response.json()) as { error?: string; duplicate?: boolean; capabilityId?: string | null };
      if (!response.ok) {
        setError(payload.error ?? "投递失败。");
        return;
      }
      setFile(null);
      setSourceUrl("");
      setText("");
      if (inputRef.current) inputRef.current.value = "";
      if (payload.duplicate) {
        setDuplicateNotice(true);
        setDuplicateCapabilityId(payload.capabilityId ?? null);
      }
      router.refresh();
    } catch {
      setError("投递失败。");
    } finally {
      setPending(false);
    }
  }

  const submitLabel = pending ? "投递中…"
    : linkInvalid ? "链接需以 https:// 开头"
    : hasContent ? (bothFilled && !file ? "链接和文字请只填一项" : "投递")
    : "选择图片或填写内容后投递";
  const submitDisabled = pending || !hasContent || (!file && bothFilled) || linkInvalid;

  return (
    <>
      <form className="caphub-workbench" aria-label="投递一个能力" aria-busy={pending} onSubmit={handleSubmit} noValidate>
        <section className="caphub-evidence-panel" aria-labelledby="capture-evidence-title">
          <div className="caphub-section-heading"><h2 id="capture-evidence-title">截图</h2><span>一张图片 · 最大 10 MB</span></div>
          <input ref={inputRef} id="capture-image" aria-label="截图文件" type="file" accept="image/png,image/jpeg,image/webp" hidden
            disabled={pending} onChange={(event) => chooseFile(event.currentTarget.files?.[0])} />
          <div className="caphub-drop-zone" role="group" aria-label="截图拖放区"
            onDragOver={(event) => event.preventDefault()} onDrop={handleDrop} onPaste={handlePaste}>
            {file ? (
              <div className="caphub-selected-file">
                <span className="caphub-file-mark" aria-hidden="true">{file.type.split("/")[1].toUpperCase()}</span>
                <div><strong>{file.name}</strong><small>{file.type} · {formatBytes(file.size)}</small></div>
                <button className="caphub-quiet-button" type="button" onClick={clearFile} disabled={pending}>清除图片</button>
              </div>
            ) : (
              <div className="caphub-drop-content">
                <span className="caphub-upload-mark" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </span>
                <span className="caphub-promise">投递 → 分析 → 建档</span>
                <h3>把截图拖到这里</h3>
                <p>支持 PNG、JPEG、WebP，也可以直接粘贴。同一张图不会重复分析。</p>
                <button className="caphub-quiet-button" type="button" onClick={() => inputRef.current?.click()} disabled={pending}>选择图片</button>
              </div>
            )}
            {error && <p className="caphub-inline-error" role="alert">{error}</p>}
          </div>
        </section>
        <section className="caphub-context-panel" aria-labelledby="capture-context-title">
          <div className="caphub-section-heading">
            <h2 id="capture-context-title">文字或链接</h2>
            <span>{file ? "本次投递图片" : "不传图时使用"}</span>
          </div>
          <div className="caphub-field">
            <label htmlFor="capture-source">链接 <span>仅 HTTPS</span></label>
            <input id="capture-source" type="text" inputMode="url" placeholder="https://github.com/…" value={sourceUrl}
              disabled={pending || !!file} aria-invalid={linkInvalid} onChange={(event) => setSourceUrl(event.target.value)} />
            {linkInvalid ? (
              <p className="caphub-inline-error" role="alert">链接需以 https:// 开头</p>
            ) : (
              <p>一个能力的网页、仓库或文章地址。</p>
            )}
          </div>
          <div className="caphub-field">
            <label htmlFor="capture-text">文字 <span>{text.length.toLocaleString("en-US")} / 4,000</span></label>
            <textarea id="capture-text" maxLength={4000} placeholder="粘贴一段 prompt、经验或说明……" value={text}
              disabled={pending || !!file} onChange={(event) => setText(event.target.value)} onPaste={handlePaste} />
          </div>
          <button className="caphub-submit" type="submit" disabled={submitDisabled}>
            {pending && <span className="caphub-spinner" aria-hidden="true" />}{submitLabel}
          </button>
        </section>
      </form>
      {duplicateNotice && (
        <p className="notice caphub-duplicate-notice" role="status">
          这条内容之前投递过，已指向原记录
          {duplicateCapabilityId && (
            <>
              {" "}
              <Link href={`/library/${duplicateCapabilityId}`}>查看已有卡片</Link>
            </>
          )}
        </p>
      )}
      <section className="caphub-custody" aria-label="投递说明">
        <div>
          <strong>投递一次，在这里跟进分析。</strong>
          <p>原图在 30 天后清除，分析结果与卡片保留。把握大的结论会自动执行。</p>
        </div>
        <span className="caphub-custody__state">拿不准的进 Review</span>
      </section>
    </>
  );
}
