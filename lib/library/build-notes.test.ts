import { describe, expect, it } from "vitest";
import { normalizeNote } from "./build-notes";

describe("normalizeNote", () => {
  it("fills a default author and trims", () => {
    expect(normalizeNote({ by: "  ", text: "  用 gsap-skills 直接装上了  " }))
      .toEqual({ at: expect.any(String), by: "agent", text: "用 gsap-skills 直接装上了" });
  });
  it("rejects an empty or over-long note", () => {
    expect(normalizeNote({ by: "claude", text: "   " })).toBeNull();
    expect(normalizeNote({ by: "claude", text: "字".repeat(2001) })).toBeNull();
  });
  it("accepts a note exactly at the cap", () => {
    expect(normalizeNote({ by: "claude", text: "字".repeat(2000) })?.text).toHaveLength(2000);
  });
  it("truncates an over-long author name", () => {
    expect(normalizeNote({ by: "a".repeat(80), text: "x" })?.by).toHaveLength(40);
  });
});
