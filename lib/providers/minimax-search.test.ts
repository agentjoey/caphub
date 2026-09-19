import { describe, expect, it } from "vitest";
import { createMiniMaxSearch, truncateSources } from "./minimax-search";

describe("createMiniMaxSearch", () => {
  it("sends web_search tool and collects url_citation annotations, truncated", async () => {
    let body: Record<string, unknown> = {};
    const long = "x".repeat(5000);
    const fetchFn = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        status: "completed",
        output: [
          { type: "web_search_call", status: "completed", action: { type: "search" } },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "summary", annotations: [
            { type: "url_citation", title: "A", url: "https://a.example/", content: long },
            { type: "url_citation", title: "B", url: "https://b.example/", content: "short" }
          ] }] }
        ],
        usage: { input_tokens: 100, output_tokens: 5 }
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await createMiniMaxSearch({ apiKey: "k", fetch: fetchFn }).search("q", new AbortController().signal);
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(out.value.sources).toHaveLength(2);
    expect(out.value.sources[0].content).toHaveLength(2048);
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 5 });
  });

  it("rejects a completed response without a web_search_call item", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "summary", annotations: [
        { type: "url_citation", title: "A", url: "https://a.example/", content: "c" }
      ] }] }],
      usage: { input_tokens: 100, output_tokens: 5 }
    }), { status: 200 })) as unknown as typeof fetch;
    await expect(createMiniMaxSearch({ apiKey: "k", fetch: fetchFn }).search("q", new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  });

  it("rejects a completed response missing usage", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({
      status: "completed",
      output: [
        { type: "web_search_call", status: "completed", action: { type: "search" } },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "summary", annotations: [
          { type: "url_citation", title: "A", url: "https://a.example/", content: "c" }
        ] }] }
      ]
    }), { status: 200 })) as unknown as typeof fetch;
    await expect(createMiniMaxSearch({ apiKey: "k", fetch: fetchFn }).search("q", new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  });
});

describe("truncateSources", () => {
  it("strips NUL and other C0 control chars from title/content but keeps newlines", () => {
    const out = truncateSources([
      { title: "ti\u0000tle\u0001", url: "https://a.example/", content: "line1\nline2\u0000\rline3\u0007" }
    ]);
    expect(out[0].title).toBe("title");
    expect(out[0].content).toBe("line1\nline2\rline3");
  });
});
