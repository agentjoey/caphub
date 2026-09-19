import { createGeminiEmbed } from "../providers/gemini-embed";

const TIMEOUT_MS = 5_000;

/**
 * Computes a query embedding for hybrid library search. Never throws: when no API key is
 * configured, or the call fails or times out (5s), logs a short line and returns null so the
 * caller falls back to full-text/scenario/substring matching only.
 */
export async function embedSearchQuery(
  apiKey: string | undefined,
  q: string,
  fetchImpl?: typeof fetch
): Promise<number[] | null> {
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const embed = createGeminiEmbed({ apiKey, fetch: fetchImpl });
    const [vector] = await embed.embed([q], "query", controller.signal);
    return vector ?? null;
  } catch (error) {
    // Short message only: no stack trace, no error object (never risk leaking a provider
    // response body or other detail into logs).
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`library search: query embedding failed, falling back to non-semantic search (${message})`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
