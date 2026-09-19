import { describe, expect, it } from "vitest";
import { parseJsonObject } from "./prompt";

describe("parseJsonObject", () => {
  it("parses a plain JSON object", () => {
    expect(parseJsonObject('{"n":1}')).toEqual({ n: 1 });
  });
  it("strips a markdown code fence", () => {
    expect(parseJsonObject('```json\n{"n":1}\n```')).toEqual({ n: 1 });
  });
  it("extracts a JSON object wrapped in a leading and trailing prose line", () => {
    expect(parseJsonObject('Here is the result:\n{"n":1}\nHope that helps.')).toEqual({ n: 1 });
  });
  it("throws on text with no JSON object at all", () => {
    expect(() => parseJsonObject("not json at all")).toThrow();
  });
  it("throws when the braces do not contain valid JSON", () => {
    expect(() => parseJsonObject("prefix { not: valid, json } suffix")).toThrow();
  });
});
