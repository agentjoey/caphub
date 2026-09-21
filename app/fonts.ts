import localFont from "next/font/local";
import { IBM_Plex_Mono } from "next/font/google";

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

/** The `className` every root layout puts on `<html>`, so the desktop chrome and the Telegram
 * Mini App shell share one font stack instead of each declaring its own. */
export const fontVariables = `${generalSans.variable} ${plexMono.variable}`;
