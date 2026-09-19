import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDeepSeekCall } from "./deepseek";

describe("createDeepSeekCall", () => {
  it("posts responses request with json_schema format and parses output", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "{\"n\":2}" }] }], usage: { input_tokens: 3, output_tokens: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await createDeepSeekCall({ apiKey: "k", fetch: fetchFn }).invoke({ prompt: "p", schemaName: "card", schema: z.object({ n: z.number() }) }, new AbortController().signal);
    expect(out.value).toEqual({ n: 2 });
    expect(body.model).toBe("deepseek-flash");
    expect((body.text as { format: { type: string; name: string } }).format).toMatchObject({ type: "json_schema", name: "card" });
    expect(JSON.stringify(body)).not.toMatch(/image/);
  });
  it("includes status and body excerpt as detail on a non-2xx response", async () => {
    const fetchFn = (async () => new Response("bad request: invalid schema", { status: 400 })) as unknown as typeof fetch;
    await expect(createDeepSeekCall({ apiKey: "k", fetch: fetchFn }).invoke({ prompt: "p", schemaName: "card", schema: z.object({ n: z.number() }) }, new AbortController().signal))
      .rejects.toMatchObject({ code: "INVALID_OUTPUT", detail: expect.stringContaining("400") });
  });
  it("throws INVALID_OUTPUT with raw text and usage when the response text is not parseable JSON", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "not json at all" }] }], usage: { input_tokens: 3, output_tokens: 1 } }), { status: 200 })) as unknown as typeof fetch;
    await expect(createDeepSeekCall({ apiKey: "k", fetch: fetchFn }).invoke({ prompt: "p", schemaName: "card", schema: z.object({ n: z.number() }) }, new AbortController().signal))
      .rejects.toMatchObject({ code: "INVALID_OUTPUT", raw: "not json at all", usage: { inputTokens: 3, outputTokens: 1 } });
  });
  it("parses a JSON object wrapped in a leading/trailing prose line", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Here is the result:\n{\"n\":2}\nHope that helps." }] }], usage: { input_tokens: 3, output_tokens: 1 } }), { status: 200 })) as unknown as typeof fetch;
    const out = await createDeepSeekCall({ apiKey: "k", fetch: fetchFn }).invoke({ prompt: "p", schemaName: "card", schema: z.object({ n: z.number() }) }, new AbortController().signal);
    expect(out.value).toEqual({ n: 2 });
  });
});
