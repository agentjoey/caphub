import "../globals.css";
import type { ReactNode } from "react";
import { AppShell } from "../../components/shell/app-shell";
import { fontVariables } from "../fonts";
import { getLocale } from "../../lib/i18n/locale";
import { getDict } from "../../lib/i18n";
import { countPending } from "../../lib/library/queries";
import { getRuntime } from "../../lib/runtime";

export const metadata = { title: "Caphub" };

/**
 * Root layout of the desktop surface (`/`, `/review`, `/library/*`). It is one of two root
 * layouts: `/mini` has its own (`app/mini/layout.tsx`) precisely so the Telegram Mini App does
 * *not* inherit `AppShell` — its brand link and primary nav would navigate Telegram's WebView
 * out of the Mini App onto a surface with no mobile styling and no mini session.
 */
export default async function ChromeLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const dict = getDict(locale);
  const pending = await countPending(getRuntime().pool);
  return (
    <html lang={locale === "en" ? "en" : "zh-CN"} className={fontVariables}>
      <body><AppShell locale={locale} dict={dict} pending={pending}>{children}</AppShell></body>
    </html>
  );
}
