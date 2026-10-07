import Link from "next/link";
import type { ReactNode } from "react";
import type { Dict, Locale } from "../../lib/i18n";
import { LangSwitch } from "./lang-switch";
import { PrimaryNav } from "./primary-nav";

export function AppShell({ children, locale, dict, pending = 0 }: { children: ReactNode; locale: Locale; dict: Dict; pending?: number }) {
  return (
    <div className="app-layout">
      <a href="#main" className="skip-link">{dict.shell.skipLink}</a>
      <header className="app-header">
        <Link href="/" className="brand" aria-label={dict.shell.homeAria}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /><path d="M3 9h6" />
          </svg>
          <span className="brand__text">Caphub <span className="brand__sub">/ {dict.shell.brandSub}</span></span>
        </Link>
        <PrimaryNav
          navAria={dict.shell.navAria}
          labels={{ "/": dict.shell.navCapture, "/review": dict.shell.navReview, "/library": dict.shell.navLibrary }}
          counts={{ "/review": pending }}
          countAria={dict.shell.navCountAria}
        />
        <LangSwitch locale={locale} ariaLabel={dict.shell.langSwitchAria} />
      </header>
      <main id="main" className="main-content">{children}</main>
    </div>
  );
}
