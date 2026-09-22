import type { StructuredCall, StructuredInput } from "../analysis/structured";
import { ProviderError, failureForHttpStatus } from "./errors";
import { buildStructuredPrompt, parseJsonObject } from "./prompt";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

/**
 * Gemini watching a YouTube video by URL (spike: docs/spike-video.md). Google fetches the video
 * itself -- Caphub never downloads it -- so this only works for public videos. The key goes in
 * a header and is never echoed into errors.
 */
export function createGeminiVideoCall(opts: { apiKey: string; model: string; fetch?: typeof fetch }): StructuredCall {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  return {
    provider: "gemini",
    model: opts.model,
    async invoke(input: StructuredInput, signal: AbortSignal) {
      if (!input.video) throw new ProviderError("INVALID_OUTPUT", { detail: "gemini video call requires input.video" });
      const videoPart: Record<string, unknown> = { fileData: { fileUri: input.video.url } };
      if (input.video.endOffsetSec !== undefined) videoPart.videoMetadata = { endOffset: `${input.video.endOffsetSec}s` };
      let response: Response;
      try {
        response = await fetchFn(`${GEMINI_BASE_URL}/models/${opts.model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": opts.apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [videoPart, { text: buildStructuredPrompt(input) }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
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
      let payload: GenerateContentResponse;
      try { payload = await response.json() as GenerateContentResponse; } catch (error) { throw new ProviderError("INVALID_OUTPUT", { cause: error }); }
      const text = (payload.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      const meta = payload.usageMetadata;
      if (!text.trim() || typeof meta?.promptTokenCount !== "number") throw new ProviderError("INVALID_OUTPUT", { detail: "empty candidate or missing usage" });
      const usage = { inputTokens: meta.promptTokenCount, outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0) };
      let value: unknown;
      try { value = parseJsonObject(text); } catch (error) {
        throw new ProviderError("INVALID_OUTPUT", { cause: error, raw: text.slice(0, 20_000), usage });
      }
      return { value, usage };
    }
  };
}
