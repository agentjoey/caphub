"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** True while the user is mid-edit: a field has focus, or an open editor marks itself `data-editing`. */
function isEditing(): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (active && (active.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName))) return true;
  return document.querySelector("[data-editing]") !== null;
}

/**
 * Re-renders the current page every `intervalMs` while something on it is still being analysed,
 * so a queued capture walks through its stages and lands as a card without a manual reload.
 *
 * - Paused while the tab is hidden; on coming back it refreshes once straight away.
 * - Skipped while the user is editing: a refresh would re-seed a panel's optimistic-lock token
 *   (components/capability/use-lock-token.ts) under an open form, and its save would then
 *   overwrite the fresh analysis instead of reporting the conflict.
 * - Gives up after `maxMs`, so a stuck queue (worker down) doesn't poll for as long as the tab
 *   stays open; any navigation or reload starts it again.
 * Renders nothing.
 */
export function PipelineWatcher({ active, intervalMs = 4000, maxMs = 15 * 60 * 1000 }: { active: boolean; intervalMs?: number; maxMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const startedAt = Date.now();
    const tick = () => {
      if (Date.now() - startedAt > maxMs) return stop();
      if (!document.hidden && !isEditing()) router.refresh();
    };
    const timer = window.setInterval(tick, intervalMs);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    function stop() {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    }
    document.addEventListener("visibilitychange", onVisible);
    return stop;
  }, [active, intervalMs, maxMs, router]);
  return null;
}
