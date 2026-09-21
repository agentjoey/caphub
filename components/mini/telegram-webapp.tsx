"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

export interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  [key: string]: string | undefined;
}

export interface TelegramWebApp {
  initData: string;
  colorScheme: "light" | "dark";
  themeParams: TelegramThemeParams;
  ready(): void;
  expand(): void;
  onEvent(event: string, handler: () => void): void;
  offEvent(event: string, handler: () => void): void;
  BackButton: {
    show(): void;
    hide(): void;
    onClick(handler: () => void): void;
    offClick(handler: () => void): void;
  };
  MainButton: {
    setText(text: string): void;
    show(): void;
    hide(): void;
    onClick(handler: () => void): void;
    offClick(handler: () => void): void;
    enable(): void;
    disable(): void;
  };
  HapticFeedback: {
    impactOccurred(style: string): void;
    notificationOccurred(type: string): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

/**
 * Reads the live Telegram WebApp bridge, or null outside Telegram (SSR, a plain browser tab,
 * or any environment without the Telegram client). BackButton/MainButton use this directly
 * instead of going through context, so they work standalone in any /mini page.
 */
export function getTelegramWebApp(): TelegramWebApp | null {
  if (typeof window === "undefined") return null;
  return window.Telegram?.WebApp ?? null;
}

// `ready` and `colorScheme` are read from window.Telegram.WebApp, an external system React does
// not own — useSyncExternalStore (not useState+useEffect) is the correct primitive for that.
// It is also what keeps first render SSR-safe: the server snapshot is always
// "not ready / light", matching the very first client render bit-for-bit, and React
// reconciles to the real client value right after that render with no manual effect needed.
function subscribeToThemeChange(callback: () => void): () => void {
  const webApp = getTelegramWebApp();
  if (!webApp) return () => {};
  webApp.onEvent("themeChanged", callback);
  return () => webApp.offEvent("themeChanged", callback);
}

function noopSubscribe(): () => void {
  // Whether Telegram is present does not change again after mount in practice (the bridge is
  // injected before the app boots or not at all) — nothing to subscribe to.
  return () => {};
}

function getReadySnapshot(): boolean {
  return getTelegramWebApp() !== null;
}

function getReadyServerSnapshot(): boolean {
  return false;
}

function getColorSchemeSnapshot(): "light" | "dark" {
  return getTelegramWebApp()?.colorScheme ?? "light";
}

function getColorSchemeServerSnapshot(): "light" | "dark" {
  return "light";
}

interface TelegramContextValue {
  ready: boolean;
  colorScheme: "light" | "dark";
  haptic: (kind: "impact" | "success" | "warning") => void;
}

const defaultContext: TelegramContextValue = {
  ready: false,
  colorScheme: "light",
  haptic: () => {},
};

const TelegramContext = createContext<TelegramContextValue>(defaultContext);

export function useTelegram(): TelegramContextValue {
  return useContext(TelegramContext);
}

// Only background/foreground follow Telegram's live theme — cards, pills and fonts keep their
// own tokens (globals.css). This is deliberately narrow: two properties, no new palette.
function applyThemeTokens(theme: TelegramThemeParams): void {
  const root = document.documentElement;
  if (theme.bg_color) root.style.setProperty("--paper", theme.bg_color);
  if (theme.text_color) root.style.setProperty("--ink", theme.text_color);
}

export function TelegramProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const ready = useSyncExternalStore(noopSubscribe, getReadySnapshot, getReadyServerSnapshot);
  const colorScheme = useSyncExternalStore(
    subscribeToThemeChange,
    getColorSchemeSnapshot,
    getColorSchemeServerSnapshot
  );
  // Guards against requesting a session twice if the setup effect below ever re-runs — the
  // POST carries initData and should fire at most once per mount.
  const sessionRequested = useRef(false);

  // Reacts to colorScheme (mount + every themeChanged): mirror it onto <html data-theme> and
  // the existing --paper/--ink tokens. Pure synchronization, no setState here.
  useEffect(() => {
    const webApp = getTelegramWebApp();
    if (!webApp) return;
    document.documentElement.dataset.theme = webApp.colorScheme;
    applyThemeTokens(webApp.themeParams);
  }, [colorScheme]);

  // One-time setup once Telegram is confirmed present: acknowledge readiness, expand to full
  // height, and exchange initData for the mini session cookie.
  useEffect(() => {
    if (!ready) return;
    const webApp = getTelegramWebApp();
    if (!webApp) return;

    webApp.ready();
    webApp.expand();

    if (!sessionRequested.current && webApp.initData) {
      sessionRequested.current = true;
      // Never log or forward initData anywhere else — this is its only destination.
      fetch("/api/mini/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: webApp.initData }),
      })
        .then((res) => {
          if (res.ok) router.refresh();
        })
        .catch(() => {
          // Best-effort: on failure the guard still gates every other /mini/* page, so the
          // owner just sees a 401 on the next navigation and can reopen the Mini App to retry.
        });
    }
  }, [ready, router]);

  const haptic = useCallback((kind: "impact" | "success" | "warning") => {
    const webApp = getTelegramWebApp();
    if (!webApp) return;
    if (kind === "impact") webApp.HapticFeedback.impactOccurred("light");
    else webApp.HapticFeedback.notificationOccurred(kind);
  }, []);

  return (
    <TelegramContext.Provider value={{ ready, colorScheme, haptic }}>
      {children}
    </TelegramContext.Provider>
  );
}
