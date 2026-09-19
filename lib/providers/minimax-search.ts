import { z } from "zod";
import { MAX_SOURCES, MAX_SOURCE_CONTENT, searchResultSchema, type SearchResult } from "../analysis/card";
import { ProviderError, failureForHttpStatus } from "./errors";
import { MINIMAX_BASE_URL, MINIMAX_MODEL } from "./minimax";

export interface SearchCall {
  provider: string;
  model: string;
  search(query: string, signal: AbortSignal): Promise<{ value: SearchResult; usage: { inputTokens: number; outputTokens: number }; provider: string }>;
}

export function truncateSources(sources: Array<{ title: string; url: string; content: string }>): SearchResult["sources"] {
  const seen = new Set<string>();
  const out: SearchResult["sources"] = [];
  for (const s of sources) {
    if (!s.url.startsWith("https://") || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({ title: s.title.slice(0, 300), url: s.url, content: s.content.slice(0, MAX_SOURCE_CONTENT) });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

const citation = z.object({ type: z.literal("url_citation"), title: z.string(), url: z.string(), content: z.string().default("") }).passthrough();
const responseSchema = z.object({
  status: z.string(),
  output: z.array(z.object({ type: z.string(), content: z.array(z.object({ type: z.string(), annotations: z.array(z.unknown()).default([]) }).passthrough()).default([]) }).passthrough()).default([]),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional()
}).passthrough();

export function createMiniMaxSearch(opts: { apiKey: string; fetch?: typeof fetch }): SearchCall {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  return {
    provider: "minimax",
    model: MINIMAX_MODEL,
    async search(query, signal) {
      let response: Response;
      try {
        response = await fetchFn(`${MINIMAX_BASE_URL}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: MINIMAX_MODEL, input: `搜索并给出与下面内容最相关的网页来源：\n${query}`, stream: false, tools: [{ type: "web_search" }] }),
          signal
        });
      } catch (error) {
        throw new ProviderError(signal.aborted ? "ABORTED" : "UNAVAILABLE", { cause: error });
      }
      if (!response.ok) throw new ProviderError(failureForHttpStatus(response.status));
      const parsed = responseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success || parsed.data.status !== "completed") throw new ProviderError("INVALID_OUTPUT");
      const annotations = parsed.data.output.flatMap((m) => m.content.flatMap((c) => c.annotations));
      const sources = annotations.map((a) => citation.safeParse(a)).filter((r) => r.success).map((r) => r.data);
      return {
        value: searchResultSchema.parse({ sources: truncateSources(sources) }),
        usage: { inputTokens: parsed.data.usage?.input_tokens ?? 0, outputTokens: parsed.data.usage?.output_tokens ?? 0 },
        provider: "minimax"
      };
    }
  };
}
