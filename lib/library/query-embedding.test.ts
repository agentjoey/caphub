import { describe, expect, it, vi } from "vitest";
import { embedSearchQuery } from "./query-embedding";

function fakeFetch(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response);
}

const VALUES = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));

describe("embedSearchQuery", () => {
  it("returns null when no API key is configured", async () => {
    const fetchImpl = vi.fn();
    expect(await embedSearchQuery(undefined, "hello", fetchImpl as unknown as typeof fetch)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns the normalized vector on success", async () => {
    const fetchImpl = fakeFetch({ embeddings: [{ values: VALUES }] });
    const result = await embedSearchQuery("key", "hello", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual(VALUES);
  });

  it("returns null (never throws) when the call fails", async () => {
    const fetchImpl = fakeFetch({}, false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await embedSearchQuery("key", "hello", fetchImpl as unknown as typeof fetch)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns null (never throws) when the fetch itself throws", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("network down"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await embedSearchQuery("key", "hello", fetchImpl as unknown as typeof fetch)).toBeNull();
    warn.mockRestore();
  });
});
