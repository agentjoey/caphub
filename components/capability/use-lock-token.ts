"use client";

import { useState } from "react";

/**
 * Holds a card's optimistic-lock token (`capabilities.updated_at`) for a panel that mutates the
 * row: the panel advances it locally from its own action's result, and re-seeds it whenever the
 * server sends down a newer one.
 *
 * Both detail-page panels (ProgressControl and DetailActions) can bump the same row's
 * `updated_at`, and after either one saves it calls `router.refresh()`, which re-renders the
 * server component with the new token but does NOT remount the panels. Without this re-seed the
 * panel that didn't save keeps comparing against the token it first mounted with and spuriously
 * CONFLICTs on its next action. Keying the panels on `updatedAt` used to force that remount, but
 * two siblings keyed on the same value are duplicate keys — React then rendered both panels
 * twice — so the token is synced here instead, following React's "adjust state when a prop
 * changes" pattern (a set during render, which React re-runs immediately without a paint).
 */
export function useLockToken(serverToken: string): [string, (next: string) => void] {
  const [token, setToken] = useState(serverToken);
  const [seenServerToken, setSeenServerToken] = useState(serverToken);
  if (serverToken !== seenServerToken) {
    setSeenServerToken(serverToken);
    setToken(serverToken);
  }
  return [token, setToken];
}
