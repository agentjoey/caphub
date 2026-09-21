"use client";

import { useRouter } from "next/navigation";
import { BackButton } from "./back-button";

/**
 * Registers Telegram's native BackButton and wires it to `router.back()` — the shared pattern
 * for every `/mini` page below the library list (detail, review). A thin client wrapper because
 * the pages themselves are server components and `useRouter()` needs a client boundary.
 */
export function RouterBackButton() {
  const router = useRouter();
  return <BackButton onClick={() => router.back()} />;
}
