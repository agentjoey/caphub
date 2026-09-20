/**
 * Guards a model-supplied URL (source_facts.repo_url/homepage, capabilities.source_url, …)
 * before it's ever used as an `<a href>`. This repo's zod schemas accept any `z.string().url()`
 * value — including `javascript:` and `data:` — so a poisoned capture/analysis result could
 * otherwise produce a clickable script link. Only http/https survives; everything else (a bad
 * scheme, or a string that doesn't even parse as a URL) is rejected and the caller should render
 * the raw text instead of an anchor.
 */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
}
