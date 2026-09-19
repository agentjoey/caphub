import { describe, expect, it } from "vitest";
import { dedupeKeyFor, normalizeText } from "./dedupe";

describe("dedupeKeyFor", () => {
  it("is content sha256 for images", () => {
    const k = dedupeKeyFor({ source: "web", kind: "image", bytes: new TextEncoder().encode("x"), mimeType: "image/png" });
    expect(k).toBe("2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
  });
  it("normalizes text whitespace and url trailing slash", () => {
    const a = dedupeKeyFor({ source: "web", kind: "text", text: "  hello   world \n" });
    const b = dedupeKeyFor({ source: "web", kind: "text", text: "hello world" });
    expect(a).toBe(b);
    expect(dedupeKeyFor({ source: "web", kind: "url", url: "https://a.b/c/" })).toBe(dedupeKeyFor({ source: "web", kind: "url", url: "https://a.b/c" }));
  });
  it("rejects non-https url", () => {
    expect(() => dedupeKeyFor({ source: "web", kind: "url", url: "http://a.b" })).toThrow(/https/);
  });
});

describe("normalizeText", () => {
  it("strips U+0000", () => {
    expect(normalizeText("has\u0000nul")).toBe("hasnul");
  });
});
