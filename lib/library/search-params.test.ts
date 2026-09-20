import { describe, expect, it } from "vitest";
import { libraryHref, parseLibraryParams } from "./search-params";

describe("library search params", () => {
  it("parses q, repeated type/tag/scenario/progress, usage, discarded, page and drops invalid values", () => {
    const f = parseLibraryParams({
      q: " scraping ", type: ["skill", "nope"], tag: ["python", "Bad Tag"], scenario: ["coding", "Not Valid!"],
      usage: "integrate", progress: ["todo", "bogus"], discarded: "1", page: "3"
    });
    expect(f).toEqual({
      q: "scraping", types: ["skill"], tags: ["python"], scenarios: ["coding"], usage: "integrate",
      progress: ["todo"], discarded: true, page: 3
    });
  });
  it("builds hrefs and resets page when filters change", () => {
    const f = parseLibraryParams({ q: "x", page: "4" });
    expect(libraryHref(f, { tags: ["python"] })).toBe("/library?q=x&tag=python");
  });
  it("builds hrefs with a scenario filter", () => {
    const f = parseLibraryParams({});
    expect(libraryHref(f, { scenarios: ["coding"] })).toBe("/library?scenario=coding");
  });
  it("parses repeated progress values and builds hrefs with them", () => {
    const f = parseLibraryParams({ progress: ["todo", "planned"] });
    expect(f.progress).toEqual(["todo", "planned"]);
    expect(libraryHref(f, {})).toBe("/library?progress=todo&progress=planned");
  });
  it("parses includeRetired and round-trips it through libraryHref", () => {
    const f = parseLibraryParams({ includeRetired: "1" });
    expect(f.includeRetired).toBe(true);
    expect(libraryHref(f, {})).toBe("/library?includeRetired=1");
    expect(parseLibraryParams({}).includeRetired).toBeUndefined();
  });
});
