import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ProviderError } from "./errors";
import { createGeminiVideoCall } from "./gemini-video";

const schema = z.object({ what: z.string() });
const ok = (text: string) => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: 30000, candidatesTokenCount: 200, thoughtsTokenCount: 50 }
}), { status: 200 });

describe("createGeminiVideoCall", () => {
  it("sends the YouTube URL as fileData with the prompt, and maps usage", async () => {
    const fetchFn = vi.fn(async () => ok('{"what":"w"}'));
    const call = createGeminiVideoCall({ apiKey: "K", model: "gemini-3.8-flash", fetch: fetchFn as never });
    const out = await call.invoke({ prompt: "p", schemaName: "x", schema, video: { url: "https://www.youtube.com/watch?v=tYvu6IpSfiM" } }, new AbortController().signal);
    expect(out).toEqual({ value: { what: "w" }, usage: { inputTokens: 30000, outputTokens: 250 } });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("K");
    const body = JSON.parse(String(init.body));
    expect(body.contents[0].parts[0]).toEqual({ fileData: { fileUri: "https://www.youtube.com/watch?v=tYvu6IpSfiM" } });
    expect(body.contents[0].parts[1].text).toContain("p");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    // Gemini 3 models are meant to run at default temperature (owner ruling); don't override it.
    expect(body.generationConfig.temperature).toBeUndefined();
    expect(call.provider).toBe("gemini");
    expect(call.model).toBe("gemini-3.8-flash");
  });

  it("adds videoMetadata.endOffset when clipping", async () => {
    const fetchFn = vi.fn(async () => ok('{"what":"w"}'));
    const call = createGeminiVideoCall({ apiKey: "K", model: "m", fetch: fetchFn as never });
    await call.invoke({ prompt: "p", schemaName: "x", schema, video: { url: "u", endOffsetSec: 5400 } }, new AbortController().signal);
    const body = JSON.parse(String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.contents[0].parts[0].videoMetadata).toEqual({ endOffset: "5400s" });
  });

  it("rejects a call without a video", async () => {
    const call = createGeminiVideoCall({ apiKey: "K", model: "m", fetch: vi.fn() as never });
    await expect(call.invoke({ prompt: "p", schemaName: "x", schema }, new AbortController().signal)).rejects.toThrow();
  });

  it("maps HTTP errors without leaking the key", async () => {
    const call = createGeminiVideoCall({ apiKey: "SECRET", model: "m", fetch: (async () => new Response('{"error":{"message":"Video unavailable"}}', { status: 400 })) as never });
    const err = await call.invoke({ prompt: "p", schemaName: "x", schema, video: { url: "u" } }, new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("INVALID_OUTPUT");
    expect((err as ProviderError).detail).toContain("400");
    expect((err as ProviderError).detail).not.toContain("SECRET");
  });

  it("raises INVALID_OUTPUT with raw text and usage for non-JSON text", async () => {
    const call = createGeminiVideoCall({ apiKey: "K", model: "m", fetch: (async () => ok("not json")) as never });
    const err = await call.invoke({ prompt: "p", schemaName: "x", schema, video: { url: "u" } }, new AbortController().signal).catch((e) => e) as ProviderError;
    expect(err.code).toBe("INVALID_OUTPUT");
    expect(err.raw).toBe("not json");
    expect(err.usage).toEqual({ inputTokens: 30000, outputTokens: 250 });
  });

  it("maps network failure to UNAVAILABLE and abort to ABORTED", async () => {
    const net = createGeminiVideoCall({ apiKey: "K", model: "m", fetch: (async () => { throw new Error("x"); }) as never });
    await expect(net.invoke({ prompt: "p", schemaName: "x", schema, video: { url: "u" } }, new AbortController().signal)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const c = new AbortController(); c.abort();
    const ab = createGeminiVideoCall({ apiKey: "K", model: "m", fetch: (async () => { throw new Error("aborted"); }) as never });
    await expect(ab.invoke({ prompt: "p", schemaName: "x", schema, video: { url: "u" } }, c.signal)).rejects.toMatchObject({ code: "ABORTED" });
  });
});
