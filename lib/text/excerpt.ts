/**
 * Excerpt (≤140 chars) of a text capture, for inline display alongside a card's title.
 *
 * Lives here, not next to CapturePreview: that module is `"use client"`, so every export from it
 * becomes a client reference -- a Server Component calling this function through it crashed
 * /mini/review whenever a pending card came from a text capture.
 */
export const TEXT_PREVIEW_LIMIT = 140;

export function captureTextExcerpt(text: string): string {
  return text.length > TEXT_PREVIEW_LIMIT ? `${text.slice(0, TEXT_PREVIEW_LIMIT)}…` : text;
}
