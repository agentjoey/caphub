"use client";

import { useState } from "react";

export function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail (permissions, insecure context); the button
      // simply stays in its un-copied state so the user can try again.
    }
  }

  return (
    <button type="button" className="btn" onClick={copy}>
      {copied ? "已复制" : label}
    </button>
  );
}
