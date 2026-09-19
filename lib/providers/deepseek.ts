import { z } from "zod";
import type { StructuredCall, StructuredInput } from "../analysis/structured";
import { ProviderError, failureForHttpStatus } from "./errors";
import { buildStructuredPrompt, parseJsonObject } from "./prompt";

export const DEEPSEEK_RESPONSES_URL = "https://api.deepseek.com/responses";
export const DEEPSEEK_MODEL = "deepseek-flash";

const responseSchema = z.object({
  status: z.string(),
  output: z.array(z.object({ type: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().default("") }).passthrough()).default([]) }).passthrough()).default([]),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional()
}).passthrough();

export function createDeepSeekCall(opts: { apiKey: string; fetch?: typeof fetch }): StructuredCall {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  return {
    provider: "deepseek",
    model: DEEPSEEK_MODEL,
    async invoke(input: StructuredInput, signal: AbortSignal) {
      if (input.images?.length) throw new ProviderError("INVALID_OUTPUT", { cause: new Error("deepseek call does not accept images") });
      let response: Response;
      try {
        response = await fetchFn(DEEPSEEK_RESPONSES_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: DEEPSEEK_MODEL, input: buildStructuredPrompt(input), stream: false,
            reasoning: { effort: "none" }, max_output_tokens: 8192,
            text: { format: { type: "json_schema", name: input.schemaName, schema: z.toJSONSchema(input.schema) } }
          }),
          signal
        });
      } catch (error) {
        throw new ProviderError(signal.aborted ? "ABORTED" : "UNAVAILABLE", { cause: error });
      }
      if (!response.ok) throw new ProviderError(failureForHttpStatus(response.status));
      const parsed = responseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success || parsed.data.status !== "completed") throw new ProviderError("INVALID_OUTPUT");
      const text = parsed.data.output.flatMap((m) => m.content).map((c) => c.text).find((t) => t.trim());
      if (!text) throw new ProviderError("INVALID_OUTPUT");
      let value: unknown;
      try { value = parseJsonObject(text); } catch (error) { throw new ProviderError("INVALID_OUTPUT", { cause: error }); }
      return { value, usage: { inputTokens: parsed.data.usage?.input_tokens ?? 0, outputTokens: parsed.data.usage?.output_tokens ?? 0 } };
    }
  };
}
