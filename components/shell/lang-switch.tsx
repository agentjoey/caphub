"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Locale } from "../../lib/i18n";
import { setLocaleAction } from "../../lib/i18n/set-locale-action";

export function LangSwitch({ locale, ariaLabel }: { locale: Locale; ariaLabel: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function switchTo(next: Locale) {
    if (next === locale || pending) return;
    startTransition(async () => {
      await setLocaleAction(next);
      router.refresh();
    });
  }

  return (
    <div className="lang-switch" role="group" aria-label={ariaLabel}>
      <button type="button" aria-pressed={locale === "zh"} disabled={pending} onClick={() => switchTo("zh")}>中文</button>
      <button type="button" aria-pressed={locale === "en"} disabled={pending} onClick={() => switchTo("en")}>EN</button>
    </div>
  );
}
