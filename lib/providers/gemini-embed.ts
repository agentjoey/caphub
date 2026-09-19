import { z } from "zod";
import { withTimeout } from "../analysis/structured";
import { ProviderError, failureForHttpStatus } from "./errors";

const GEMINI_EMBED_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents";
const EMBED_DIMENSIONS = 768;
const MAX_TEXTS = 100;
const TIMEOUT_MS = 15_000;

export type EmbedKind = "document" | "query";

export interface GeminiEmbed {
  embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<number[][]>;
}

const responseSchema = z.object({
  embeddings: z.array(z.object({ values: z.array(z.number()) }))
}).passthrough();

function l2Normalize(values: number[]): number[] {
  if (values.length !== EMBED_DIMENSIONS || !values.every((v) => Number.isFinite(v))) throw new ProviderError("INVALID_OUTPUT");
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  if (!(norm > 0)) throw new ProviderError("INVALID_OUTPUT");
  return values.map((v) => v / norm);
}

export function createGeminiEmbed(opts: { apiKey: string; fetch?: typeof fetch }): GeminiEmbed {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  return {
    async embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<number[][]> {
      if (texts.length > MAX_TEXTS) throw new Error(`gemini embed: max ${MAX_TEXTS} texts per call, got ${texts.length}`);
      const outerSignal = signal ?? new AbortController().signal;
      const t = withTimeout(outerSignal, TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetchFn(GEMINI_EMBED_URL, {
          method: "POST",
          headers: { "x-goog-api-key": opts.apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            requests: texts.map((text) => ({
              model: "models/gemini-embedding-001",
              content: { parts: [{ text }] },
              taskType: kind === "document" ? "RETRIEVAL_DOCUMENT" : "RETRIEVAL_QUERY",
              outputDimensionality: EMBED_DIMENSIONS
            }))
          }),
          signal: t.signal
        });
      } catch (error) {
        throw new ProviderError(t.timedOut() ? "TIMEOUT" : outerSignal.aborted ? "ABORTED" : "UNAVAILABLE", { cause: error });
      } finally {
        t.clear();
      }
      if (!response.ok) throw new ProviderError(failureForHttpStatus(response.status));
      const parsed = responseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new ProviderError("INVALID_OUTPUT");
      if (parsed.data.embeddings.length !== texts.length) throw new ProviderError("INVALID_OUTPUT");
      return parsed.data.embeddings.map((e) => l2Normalize(e.values));
    }
  };
}
