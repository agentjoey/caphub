"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-renders the current page every `intervalMs` while something on it is still being analysed,
 * so a queued capture walks through its stages and lands as a card without a manual reload.
 * Paused while the tab is hidden; on coming back it refreshes once straight away. Renders nothing.
 */
export function PipelineWatcher({ active, intervalMs = 4000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) router.refresh();
    }, intervalMs);
    const onVisible = () => {
      if (!document.hidden) router.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, intervalMs, router]);
  return null;
}
