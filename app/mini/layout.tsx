import "../globals.css";
import "./mini.css";
import type { ReactNode } from "react";
import Script from "next/script";
import { TELEGRAM_SDK_SRC, TelegramProvider } from "../../components/mini/telegram-webapp";
import { fontVariables } from "../fonts";
import { getLocale } from "../../lib/i18n/locale";

export const metadata = { title: "Caphub" };

/**
 * Root layout of the Telegram Mini App. It is deliberately a *second* root layout (the desktop
 * surface has its own under `app/(chrome)/`) rather than a nested one: `AppShell`'s brand link
 * and primary nav would navigate Telegram's WebView out of the Mini App onto `/`, `/review` or
 * `/library`, which are neither styled for a phone nor reachable with only a mini session.
 *
 * The Telegram SDK is loaded here, and only here, so it is scoped to `/mini*` and never shipped
 * to the desktop pages. `beforeInteractive` is what makes it a *root* layout's job (next/script
 * rejects that strategy anywhere else) and is what puts the script tag in the server HTML ahead
 * of every Next.js module. Its execution still does not block hydration, so `TelegramProvider`
 * subscribes to the script's `load` event as well — see `subscribeToBridge` there.
 */
export default async function MiniLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale === "en" ? "en" : "zh-CN"} className={fontVariables}>
      <body>
        <Script src={TELEGRAM_SDK_SRC} strategy="beforeInteractive" />
        <div id="mini-shell">
          <TelegramProvider locale={locale}>{children}</TelegramProvider>
        </div>
      </body>
    </html>
  );
}
