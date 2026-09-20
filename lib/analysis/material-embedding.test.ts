import { describe, expect, it, vi } from "vitest";
import { embedMaterialQuery } from "./material-embedding";

function fakeFetch(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response);
}

const VALUES = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));

describe("embedMaterialQuery", () => {
  it("returns null without calling fetch when no API key is configured", async () => {
    const fetchImpl = vi.fn();
    const out = await embedMaterialQuery(undefined, "hello", new AbortController().signal, fetchImpl as unknown as typeof fetch);
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null without calling fetch when the text is empty/whitespace", async () => {
    const fetchImpl = vi.fn();
    const out = await embedMaterialQuery("key", "   ", new AbortController().signal, fetchImpl as unknown as typeof fetch);
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns the normalized query embedding on success", async () => {
    const fetchImpl = fakeFetch({ embeddings: [{ values: VALUES }] });
    const out = await embedMaterialQuery("key", "a new capability", new AbortController().signal, fetchImpl as unknown as typeof fetch);
    expect(out).toEqual(VALUES);
  });

  it("never throws: returns null and logs a short line when the provider call fails", async () => {
    const fetchImpl = fakeFetch({}, false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await embedMaterialQuery("key", "a new capability", new AbortController().signal, fetchImpl as unknown as typeof fetch);
    expect(out).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("falling back to text-similarity candidates");
    warn.mockRestore();
  });

  it("never throws: returns null when the fetch itself rejects", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("network down"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await embedMaterialQuery("key", "a new capability", new AbortController().signal, fetchImpl as unknown as typeof fetch);
    expect(out).toBeNull();
    warn.mockRestore();
  });

  it("returns null when already-aborted (a timed-out or cancelled analysis run)", async () => {
    const controller = new AbortController();
    controller.abort();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn();
    const out = await embedMaterialQuery("key", "a new capability", controller.signal, fetchImpl as unknown as typeof fetch);
    expect(out).toBeNull();
    warn.mockRestore();
  });
});
