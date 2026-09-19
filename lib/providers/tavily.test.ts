import { describe, expect, it } from "vitest";
import { createTavilySearch } from "./tavily";

describe("createTavilySearch", () => {
  it("posts query with api key and maps results", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ results: Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, url: `https://s${i}.example/`, content: "c".repeat(3000) })) }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await createTavilySearch({ apiKey: "k", fetch: fetchFn }).search("q", new AbortController().signal);
    expect(body).toMatchObject({ query: "q", max_results: 6, include_answer: false });
    expect(out.value.sources).toHaveLength(6);
    expect(out.value.sources[0].content).toHaveLength(2048);
    expect(out.provider).toBe("tavily");
  });
});
