import { createGeminiEmbed } from "../providers/gemini-embed";

/**
 * A throwaway query embedding for the material currently being analysed, used only to find
 * semantic overlap candidates (see similar.ts's similarByEmbedding and pipeline.ts's
 * `loadSimilar`) on a capture's first analysis run -- before any capability row (let alone its
 * own `capabilities.embedding`) exists. This value is never written to `capabilities.embedding`;
 * that column stays owned exclusively by the separate embed worker tick
 * (lib/worker/embeddings.ts), computed from the finished, saved card.
 *
 * Deliberately mirrors lib/library/query-embedding.ts's `embedSearchQuery`: optional and
 * non-fatal. No API key, a provider error, or a timeout (createGeminiEmbed applies its own
 * internal 15s timeout whenever a signal is given) all resolve to `null` rather than throwing,
 * so a Gemini outage can never fail an analysis run -- the caller falls back to the existing
 * text-based similar.ts search instead.
 */
export async function embedMaterialQuery(
  apiKey: string | undefined,
  text: string,
  signal: AbortSignal,
  fetchImpl?: typeof fetch
): Promise<number[] | null> {
  if (!apiKey || !text.trim()) return null;
  try {
    const embed = createGeminiEmbed({ apiKey, fetch: fetchImpl });
    const [vector] = await embed.embed([text.slice(0, 2000)], "query", signal);
    return vector ?? null;
  } catch (error) {
    // Short message only, same discipline as embedSearchQuery: never log the raw error object
    // or stack, which could carry a provider response body.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`analysis: material embedding failed, falling back to text-similarity candidates (${message})`);
    return null;
  }
}
