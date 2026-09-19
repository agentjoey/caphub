import { describe, expect, it } from "vitest";
import { jsonStringifyStripNul, stripControlChars, stripNul } from "./sanitize";

describe("stripNul", () => {
  it("removes U+0000 and leaves other characters intact", () => {
    expect(stripNul("a\u0000b\u0000c")).toBe("abc");
    expect(stripNul("no nul here")).toBe("no nul here");
  });
});

describe("stripControlChars", () => {
  it("removes C0 controls including NUL but keeps tab, newline and carriage return", () => {
    expect(stripControlChars("a\u0000b\u0001c\tD\nE\rF")).toBe("abc\tD\nE\rF");
  });
});

describe("jsonStringifyStripNul", () => {
  it("strips NUL from a string nested deep inside an object", () => {
    const json = jsonStringifyStripNul({ output: { steps: [{ content: "has\u0000nul" }] } });
    expect(json).not.toContain("\\u0000");
    expect(JSON.parse(json)).toEqual({ output: { steps: [{ content: "hasnul" }] } });
  });

  it("leaves non-string values untouched", () => {
    expect(jsonStringifyStripNul({ n: 1, b: true, x: null })).toBe(JSON.stringify({ n: 1, b: true, x: null }));
  });
});
