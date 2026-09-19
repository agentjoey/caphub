import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMiniMaxCall } from "./minimax";

describe("createMiniMaxCall", () => {
  it("posts chat completion with image part and parses JSON text", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        id: "x", object: "chat.completion", created: 1, model: "MiniMax-M3",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "{\"n\":1}" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const call = createMiniMaxCall({ apiKey: "k", fetch: fetchFn });
    const out = await call.invoke({ prompt: "p", images: [{ data: new Uint8Array([1, 2]), mediaType: "image/png" }], schemaName: "t", schema: z.object({ n: z.number() }) }, new AbortController().signal);
    expect(out).toEqual({ value: { n: 1 }, usage: { inputTokens: 10, outputTokens: 2 } });
    expect(body.model).toBe("MiniMax-M3");
    expect(JSON.stringify(body)).toContain("data:image/png;base64,");
    expect(body.thinking).toEqual({ type: "disabled" });
  });
  it("maps 401 to AUTHENTICATION", async () => {
    const fetchFn = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(createMiniMaxCall({ apiKey: "k", fetch: fetchFn }).invoke({ prompt: "p", schemaName: "t", schema: z.any() }, new AbortController().signal)).rejects.toMatchObject({ code: "AUTHENTICATION" });
  });
  it("includes status and body excerpt as detail on a non-2xx response", async () => {
    const fetchFn = (async () => new Response("bad request: missing field", { status: 400 })) as unknown as typeof fetch;
    await expect(createMiniMaxCall({ apiKey: "k", fetch: fetchFn }).invoke({ prompt: "p", schemaName: "t", schema: z.any() }, new AbortController().signal))
      .rejects.toMatchObject({ code: "INVALID_OUTPUT", detail: expect.stringContaining("400") });
  });
  it("throws INVALID_OUTPUT with raw text and usage when the response text is not parseable JSON", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "not json at all" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
    }), { status: 200 })) as unknown as typeof fetch;
    await expect(createMiniMaxCall({ apiKey: "k", fetch: fetchFn }).invoke({ prompt: "p", schemaName: "t", schema: z.object({ n: z.number() }) }, new AbortController().signal))
      .rejects.toMatchObject({ code: "INVALID_OUTPUT", raw: "not json at all", usage: { inputTokens: 10, outputTokens: 2 } });
  });
  it("parses a JSON object wrapped in a leading/trailing prose line", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Here is the result:\n{\"n\":1}\nHope that helps." } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
    }), { status: 200 })) as unknown as typeof fetch;
    const out = await createMiniMaxCall({ apiKey: "k", fetch: fetchFn }).invoke({ prompt: "p", schemaName: "t", schema: z.object({ n: z.number() }) }, new AbortController().signal);
    expect(out.value).toEqual({ n: 1 });
  });
});
