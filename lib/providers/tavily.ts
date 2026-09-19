import { z } from "zod";
import { MAX_SOURCES, searchResultSchema } from "../analysis/card";
import { ProviderError, failureForHttpStatus } from "./errors";
import { truncateSources, type SearchCall } from "./minimax-search";

const TAVILY_URL = "https://api.tavily.com/search";
const tavilySchema = z.object({ results: z.array(z.object({ title: z.string().default(""), url: z.string(), content: z.string().default("") })) }).passthrough();

export function createTavilySearch(opts: { apiKey: string; fetch?: typeof fetch }): SearchCall {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  return {
    provider: "tavily",
    model: "search",
    async search(query, signal) {
      let response: Response;
      try {
        response = await fetchFn(TAVILY_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ query, max_results: MAX_SOURCES, search_depth: "basic", include_answer: false, include_raw_content: false }),
          signal
        });
      } catch (error) {
        throw new ProviderError(signal.aborted ? "ABORTED" : "UNAVAILABLE", { cause: error });
      }
      if (!response.ok) throw new ProviderError(failureForHttpStatus(response.status));
      const parsed = tavilySchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new ProviderError("INVALID_OUTPUT");
      return { value: searchResultSchema.parse({ sources: truncateSources(parsed.data.results) }), usage: { inputTokens: 0, outputTokens: 0 } };
    }
  };
}
