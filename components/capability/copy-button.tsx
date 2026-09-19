"use client";

import { useEffect, useRef, useState } from "react";
import { getDict, type Locale } from "../../lib/i18n";

type Status = "idle" | "copied" | "failed";

export function CopyButton({ text, label, locale = "zh" }: { text: string; label?: string; locale?: Locale }) {
  const dict = getDict(locale).copyButton;
  const resolvedLabel = label ?? dict.copy;
  const [status, setStatus] = useState<Status>("idle");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  async function copy() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    timeoutRef.current = setTimeout(() => setStatus("idle"), 1500);
  }

  return (
    <button type="button" className="btn" onClick={copy}>
      {status === "copied" ? dict.copied : status === "failed" ? dict.failed : resolvedLabel}
    </button>
  );
}
