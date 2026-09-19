import "./globals.css";
import type { ReactNode } from "react";
import { AppShell } from "../components/shell/app-shell";
import { getLocale } from "../lib/i18n/locale";
import { getDict } from "../lib/i18n";

export const metadata = { title: "Caphub" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const dict = getDict(locale);
  return (
    <html lang={locale === "en" ? "en" : "zh-CN"}>
      <body><AppShell locale={locale} dict={dict}>{children}</AppShell></body>
    </html>
  );
}
