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
});
