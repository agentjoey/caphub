import { describe, expect, it } from "vitest";
import { NAV_ITEMS, isNavCurrent } from "./nav";

describe("nav", () => {
  it("has the three areas in order", () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(["投递", "Review", "能力库"]);
  });
  it("marks / only on exact match and others by prefix", () => {
    expect(isNavCurrent("/", "/")).toBe(true);
    expect(isNavCurrent("/", "/review")).toBe(false);
    expect(isNavCurrent("/library", "/library/abc")).toBe(true);
    expect(isNavCurrent("/library", "/libraryx")).toBe(false);
    expect(isNavCurrent("/review", "/review")).toBe(true);
  });
});
