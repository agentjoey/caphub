"use client";

import { useEffect } from "react";
import { getTelegramWebApp } from "./telegram-webapp";

/**
 * Binds Telegram's native MainButton while mounted: sets its label, wires `onClick`, and shows
 * it. Renders nothing. Unbinds on unmount for the same reason as BackButton — otherwise the
 * next page inherits a stale label and a stale handler.
 */
export function MainButton({
  text,
  onClick,
  disabled = false,
}: {
  text: string;
  onClick: () => void;
  disabled?: boolean;
}): null {
  useEffect(() => {
    const webApp = getTelegramWebApp();
    if (!webApp) return;

    webApp.MainButton.setText(text);
    webApp.MainButton.onClick(onClick);
    webApp.MainButton.show();
    if (disabled) webApp.MainButton.disable();
    else webApp.MainButton.enable();

    return () => {
      webApp.MainButton.offClick(onClick);
      webApp.MainButton.hide();
    };
  }, [text, onClick, disabled]);

  return null;
}
