import Link from "next/link";
import type { ReactNode } from "react";
import { PrimaryNav } from "./primary-nav";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-layout">
      <a href="#main" className="skip-link">跳到正文</a>
      <header className="app-header">
        <Link href="/" className="brand" aria-label="Caphub 首页">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /><path d="M3 9h6" />
          </svg>
          <span className="brand__text">Caphub <span className="brand__sub">/ 能力库</span></span>
        </Link>
        <PrimaryNav />
      </header>
      <main id="main" className="main-content">{children}</main>
    </div>
  );
}
