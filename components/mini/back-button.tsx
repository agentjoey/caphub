"use client";

import { useEffect } from "react";
import { getTelegramWebApp } from "./telegram-webapp";

/**
 * Binds Telegram's native BackButton to `onClick` while mounted. Renders nothing — it is a
 * side-effect-only component, mounted per-page so each /mini page owns its own back behavior.
 * Unbinding on unmount is load-bearing: a page that leaves its handler registered would hijack
 * the next page's back button.
 */
export function BackButton({ onClick }: { onClick: () => void }): null {
  useEffect(() => {
    const webApp = getTelegramWebApp();
    if (!webApp) return;

    webApp.BackButton.onClick(onClick);
    webApp.BackButton.show();

    return () => {
      webApp.BackButton.offClick(onClick);
      webApp.BackButton.hide();
    };
  }, [onClick]);

  return null;
}
