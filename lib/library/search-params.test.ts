import { describe, expect, it } from "vitest";
import { libraryHref, parseLibraryParams } from "./search-params";

describe("library search params", () => {
  it("parses q, repeated type/tag, usage, discarded, page and drops invalid values", () => {
    const f = parseLibraryParams({ q: " scraping ", type: ["skill", "nope"], tag: ["python", "Bad Tag"], usage: "integrate", discarded: "1", page: "3" });
    expect(f).toEqual({ q: "scraping", types: ["skill"], tags: ["python"], usage: "integrate", discarded: true, page: 3 });
  });
  it("builds hrefs and resets page when filters change", () => {
    const f = parseLibraryParams({ q: "x", page: "4" });
    expect(libraryHref(f, { tags: ["python"] })).toBe("/library?q=x&tag=python");
  });
});
