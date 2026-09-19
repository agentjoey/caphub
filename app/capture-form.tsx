"use client";

import { useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getDict, type Locale } from "../lib/i18n";

const ACCEPTED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KiB` : `${Number((bytes / 1024 / 1024).toFixed(2))} MiB`;
}

export function CaptureForm({ locale = "zh" }: { locale?: Locale }) {
  const dict = getDict(locale).captureForm;
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
      setError(dict.fileTypeError);
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
        setError(payload.error ?? dict.submitFailed);
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
      setError(dict.submitFailed);
    } finally {
      setPending(false);
    }
  }

  const submitLabel = pending ? dict.submitting
    : linkInvalid ? dict.linkInvalid
    : hasContent ? (bothFilled && !file ? dict.bothFilledWarning : dict.submit)
    : dict.submitPlaceholder;
  const submitDisabled = pending || !hasContent || (!file && bothFilled) || linkInvalid;

  return (
    <>
      <form className="caphub-workbench" aria-label={dict.formAria} aria-busy={pending} onSubmit={handleSubmit} noValidate>
        <section className="caphub-evidence-panel" aria-labelledby="capture-evidence-title">
          <div className="caphub-section-heading"><h2 id="capture-evidence-title">{dict.evidenceTitle}</h2><span>{dict.evidenceHint}</span></div>
          <input ref={inputRef} id="capture-image" aria-label={dict.fileInputAria} type="file" accept="image/png,image/jpeg,image/webp" hidden
            disabled={pending} onChange={(event) => chooseFile(event.currentTarget.files?.[0])} />
          <div className="caphub-drop-zone" role="group" aria-label={dict.dropZoneAria}
            onDragOver={(event) => event.preventDefault()} onDrop={handleDrop} onPaste={handlePaste}>
            {file ? (
              <div className="caphub-selected-file">
                <span className="caphub-file-mark" aria-hidden="true">{file.type.split("/")[1].toUpperCase()}</span>
                <div><strong>{file.name}</strong><small>{file.type} · {formatBytes(file.size)}</small></div>
                <button className="caphub-quiet-button" type="button" onClick={clearFile} disabled={pending}>{dict.clearFile}</button>
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
                <span className="caphub-promise">{dict.promise}</span>
                <h3>{dict.dropHeading}</h3>
                <p>{dict.dropHint}</p>
                <button className="caphub-quiet-button" type="button" onClick={() => inputRef.current?.click()} disabled={pending}>{dict.chooseFile}</button>
              </div>
            )}
            {error && <p className="caphub-inline-error" role="alert">{error}</p>}
          </div>
        </section>
        <section className="caphub-context-panel" aria-labelledby="capture-context-title">
          <div className="caphub-section-heading">
            <h2 id="capture-context-title">{dict.contextTitle}</h2>
            <span>{file ? dict.contextHintWithFile : dict.contextHintNoFile}</span>
          </div>
          <div className="caphub-field">
            <label htmlFor="capture-source">{dict.linkLabel} <span>{dict.linkHint}</span></label>
            <input id="capture-source" type="text" inputMode="url" placeholder={dict.linkPlaceholder} value={sourceUrl}
              disabled={pending || !!file} aria-invalid={linkInvalid} onChange={(event) => setSourceUrl(event.target.value)} />
            {linkInvalid ? (
              <p className="caphub-inline-error" role="alert">{dict.linkInvalid}</p>
            ) : (
              <p>{dict.linkDescription}</p>
            )}
          </div>
          <div className="caphub-field">
            <label htmlFor="capture-text">{dict.textLabel} <span>{text.length.toLocaleString("en-US")} {dict.textLimit}</span></label>
            <textarea id="capture-text" maxLength={4000} placeholder={dict.textPlaceholder} value={text}
              disabled={pending || !!file} onChange={(event) => setText(event.target.value)} onPaste={handlePaste} />
          </div>
          <button className="caphub-submit" type="submit" disabled={submitDisabled}>
            {pending && <span className="caphub-spinner" aria-hidden="true" />}{submitLabel}
          </button>
        </section>
      </form>
      {duplicateNotice && (
        <p className="notice caphub-duplicate-notice" role="status">
          {dict.duplicateNotice}
          {duplicateCapabilityId && (
            <>
              {" "}
              <Link href={`/library/${duplicateCapabilityId}`}>{dict.duplicateLink}</Link>
            </>
          )}
        </p>
      )}
      <section className="caphub-custody" aria-label={dict.custodyAria}>
        <div>
          <strong>{dict.custodyTitle}</strong>
          <p>{dict.custodyBody}</p>
        </div>
        <span className="caphub-custody__state">{dict.custodyState}</span>
      </section>
    </>
  );
}
