"use client";

import { useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";

const ACCEPTED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

export function CaptureForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || (!file && !text.trim())) return;
    setPending(true);
    setError(null);
    try {
      const body = new FormData();
      if (file) body.set("file", file);
      else body.set("text", text.trim());
      const response = await fetch("/api/captures", { method: "POST", body });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(payload.error ?? "投递失败。");
        return;
      }
      setFile(null);
      setText("");
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    } catch {
      setError("投递失败。");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        onPaste={handlePaste}
        style={{
          border: `1px dashed var(--hairline-strong)`,
          borderRadius: "var(--radius-lg)",
          padding: 16,
          background: "var(--paper-raised)",
          cursor: "pointer"
        }}
        onClick={() => inputRef.current?.click()}
      >
        {file ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            {file.name} · {file.type}
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                clearFile();
              }}
              style={{
                border: `1px solid var(--hairline-strong)`,
                borderRadius: "var(--radius-sm)",
                background: "var(--paper)",
                color: "var(--ink-muted)",
                padding: "2px 8px",
                cursor: "pointer"
              }}
            >
              清除图片
            </button>
          </span>
        ) : (
          <span>拖拽、粘贴或点击选择图片（PNG/JPEG/WebP）</span>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(event) => chooseFile(event.currentTarget.files?.[0])}
        />
      </div>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onPaste={handlePaste}
        placeholder="或粘贴/输入文字或 URL"
        disabled={!!file}
        rows={3}
        style={{
          border: `1px solid var(--hairline)`,
          borderRadius: "var(--radius-md)",
          padding: 8,
          background: "var(--paper-raised)",
          color: "var(--ink)",
          fontFamily: "inherit"
        }}
      />
      {error && <p style={{ color: "var(--rust)" }}>{error}</p>}
      <button type="submit" disabled={pending || (!file && !text.trim())}>
        {pending ? "投递中…" : "投递"}
      </button>
    </form>
  );
}
