"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { BackButton } from "./back-button";

/**
 * Registers Telegram's native BackButton and wires it to `router.back()` — the shared pattern
 * for every `/mini` page below the library list (detail, review). A thin client wrapper because
 * the pages themselves are server components and `useRouter()` needs a client boundary.
 */
export function RouterBackButton() {
  const router = useRouter();
  // Stable identity on purpose: BackButton's effect is keyed on the handler, so a fresh arrow
  // per render would make every `router.refresh()` (i.e. every write on the page) unbind and
  // re-show Telegram's native back button — a visible blink.
  const goBack = useCallback(() => router.back(), [router]);
  return <BackButton onClick={goBack} />;
}
