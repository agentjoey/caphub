import type { StructuredCall, StructuredInput } from "../analysis/structured";
import { ProviderError, failureForHttpStatus } from "./errors";
import { buildStructuredPrompt, parseJsonObject } from "./prompt";

export const MINIMAX_BASE_URL = "https://api.minimax.io/v1";
export const MINIMAX_MODEL = "MiniMax-M3";

interface ChatCompletion {
  choices: Array<{ finish_reason: string; message: { content: string | null } }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

function toDataUrl(image: { data: Uint8Array; mediaType: string }): string {
  return `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`;
}

export function createMiniMaxCall(opts: { apiKey: string; fetch?: typeof fetch }): StructuredCall {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  return {
    provider: "minimax",
    model: MINIMAX_MODEL,
    async invoke(input: StructuredInput, signal: AbortSignal) {
      const content: Array<Record<string, unknown>> = [{ type: "text", text: buildStructuredPrompt(input) }];
      for (const image of input.images ?? []) content.push({ type: "image_url", image_url: { url: toDataUrl(image) } });
      let response: Response;
      try {
        response = await fetchFn(`${MINIMAX_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: MINIMAX_MODEL, messages: [{ role: "user", content }],
            max_tokens: 8192, temperature: 0.2, thinking: { type: "disabled" }, reasoning_split: true
          }),
          signal
        });
      } catch (error) {
        throw new ProviderError(signal.aborted ? "ABORTED" : "UNAVAILABLE", { cause: error });
      }
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new ProviderError(failureForHttpStatus(response.status), { detail: `HTTP ${response.status}: ${bodyText.slice(0, 500)}` });
      }
      let payload: ChatCompletion;
      try { payload = await response.json() as ChatCompletion; } catch (error) { throw new ProviderError("INVALID_OUTPUT", { cause: error }); }
      const text = payload.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) throw new ProviderError("INVALID_OUTPUT");
      if (typeof payload.usage?.prompt_tokens !== "number" || typeof payload.usage?.completion_tokens !== "number") {
        throw new ProviderError("INVALID_OUTPUT");
      }
      const usage = { inputTokens: payload.usage.prompt_tokens, outputTokens: payload.usage.completion_tokens };
      let value: unknown;
      try { value = parseJsonObject(text); } catch (error) {
        throw new ProviderError("INVALID_OUTPUT", { cause: error, raw: text.slice(0, 20_000), usage });
      }
      return { value, usage };
    }
  };
}
