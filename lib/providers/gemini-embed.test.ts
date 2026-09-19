import { describe, expect, it } from "vitest";
import { createGeminiEmbed } from "./gemini-embed";

function unitVector(seed: number): number[] {
  const values = Array.from({ length: 768 }, (_, i) => Math.sin(seed + i) * 0.6);
  return values;
}

function l2Norm(values: number[]): number {
  return Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
}

describe("createGeminiEmbed", () => {
  it("posts batchEmbedContents with the api key header and maps taskType per kind", async () => {
    let url = "";
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    const fetchFn = (async (u: string, init: RequestInit) => {
      url = u;
      headers = init.headers as Record<string, string>;
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ embeddings: [{ values: unitVector(1) }, { values: unitVector(2) }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await createGeminiEmbed({ apiKey: "k", fetch: fetchFn }).embed(["a", "b"], "document");
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents");
    expect(headers["x-goog-api-key"]).toBe("k");
    expect(body.requests).toHaveLength(2);
    expect(body.requests).toMatchObject([
      { model: "models/gemini-embedding-001", content: { parts: [{ text: "a" }] }, taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 768 },
      { model: "models/gemini-embedding-001", content: { parts: [{ text: "b" }] }, taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 768 }
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(768);
    expect(Math.abs(l2Norm(out[0]) - 1)).toBeLessThan(1e-9);
  });

  it("uses RETRIEVAL_QUERY taskType for query kind", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ embeddings: [{ values: unitVector(3) }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await createGeminiEmbed({ apiKey: "k", fetch: fetchFn }).embed(["q"], "query");
    expect((body.requests as Array<{ taskType: string }>)[0].taskType).toBe("RETRIEVAL_QUERY");
  });

  it("maps a 401 response to AUTHENTICATION", async () => {
    const fetchFn = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    await expect(createGeminiEmbed({ apiKey: "super-secret-key", fetch: fetchFn }).embed(["a"], "document"))
      .rejects.toMatchObject({ code: "AUTHENTICATION" });
  });

  it("maps a 429 response to BILLING", async () => {
    const fetchFn = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    await expect(createGeminiEmbed({ apiKey: "k", fetch: fetchFn }).embed(["a"], "document"))
      .rejects.toMatchObject({ code: "BILLING" });
  });

  it("throws INVALID_OUTPUT when the embeddings count does not match the input count", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ embeddings: [{ values: unitVector(1) }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(createGeminiEmbed({ apiKey: "k", fetch: fetchFn }).embed(["a", "b"], "document"))
      .rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  });

  it("throws INVALID_OUTPUT when a vector has the wrong dimension", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ embeddings: [{ values: [0.1, 0.2] }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(createGeminiEmbed({ apiKey: "k", fetch: fetchFn }).embed(["a"], "document"))
      .rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  });

  it("throws INVALID_OUTPUT when a vector has non-finite numbers", async () => {
    const bad = unitVector(1);
    bad[10] = Number.NaN;
    const fetchFn = (async () => new Response(JSON.stringify({ embeddings: [{ values: bad }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(createGeminiEmbed({ apiKey: "k", fetch: fetchFn }).embed(["a"], "document"))
      .rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  });

  it("throws INVALID_OUTPUT when a vector has zero norm", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ embeddings: [{ values: Array(768).fill(0) }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(createGeminiEmbed({ apiKey: "k", fetch: fetchFn }).embed(["a"], "document"))
      .rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  });

  it("throws when more than 100 texts are given, without calling fetch", async () => {
    let called = false;
    const fetchFn = (async () => { called = true; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    await expect(createGeminiEmbed({ apiKey: "k", fetch: fetchFn }).embed(Array(101).fill("x"), "document"))
      .rejects.toThrow(/max 100/);
    expect(called).toBe(false);
  });

  it("maps an aborted caller signal to ABORTED", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = (async (_u: string, init: RequestInit) => {
      if ((init.signal as AbortSignal).aborted) throw new DOMException("aborted", "AbortError");
      return new Response(JSON.stringify({ embeddings: [{ values: unitVector(1) }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(createGeminiEmbed({ apiKey: "k", fetch: fetchFn }).embed(["a"], "document", controller.signal))
      .rejects.toMatchObject({ code: "ABORTED" });
  });
});
