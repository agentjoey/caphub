import "./globals.css";
import type { ReactNode } from "react";
import { AppShell } from "../components/shell/app-shell";

export const metadata = { title: "Caphub" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body><AppShell>{children}</AppShell></body>
    </html>
  );
}
