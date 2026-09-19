import "./globals.css";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import { IBM_Plex_Mono } from "next/font/google";
import { AppShell } from "../components/shell/app-shell";
import { getLocale } from "../lib/i18n/locale";
import { getDict } from "../lib/i18n";

// General Sans (Fontshare, ITF Free Font License — see public/fonts/GeneralSans-LICENSE.txt).
const generalSans = localFont({
  src: [
    { path: "../public/fonts/GeneralSans-Regular.woff2", weight: "400", style: "normal" },
    { path: "../public/fonts/GeneralSans-Medium.woff2", weight: "500", style: "normal" },
    { path: "../public/fonts/GeneralSans-Semibold.woff2", weight: "600", style: "normal" },
    { path: "../public/fonts/GeneralSans-Bold.woff2", weight: "700", style: "normal" }
  ],
  variable: "--font-general-sans",
  display: "swap"
});

const plexMono = IBM_Plex_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-plex-mono",
  display: "swap"
});

export const metadata = { title: "Caphub" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const dict = getDict(locale);
  return (
    <html lang={locale === "en" ? "en" : "zh-CN"} className={`${generalSans.variable} ${plexMono.variable}`}>
      <body><AppShell locale={locale} dict={dict}>{children}</AppShell></body>
    </html>
  );
}
