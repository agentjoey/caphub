import { describe, expect, it } from "vitest";
import { displaySerial, formatSerial, parseSerialQuery } from "./serial";

describe("formatSerial", () => {
  it("returns null when there is no serial yet", () => {
    expect(formatSerial("skill", null)).toBeNull();
  });
  it("prefixes each type and zero-pads to 4 digits", () => {
    expect(formatSerial("skill", 12)).toBe("SKL-0012");
    expect(formatSerial("experience", 12)).toBe("EXP-0012");
    expect(formatSerial("plugin", 12)).toBe("PLG-0012");
    expect(formatSerial("prompt", 12)).toBe("PRM-0012");
    expect(formatSerial("tool", 12)).toBe("TOL-0012");
    expect(formatSerial("other", 12)).toBe("OTH-0012");
  });
  it("does not truncate serials with 5+ digits", () => {
    expect(formatSerial("skill", 12345)).toBe("SKL-12345");
  });
});

describe("displaySerial", () => {
  it("shows the serial for a kept card", () => {
    expect(displaySerial("keep", "skill", 6)).toBe("SKL-0006");
  });
  it("hides the serial for a discarded card even though it still has one in the DB", () => {
    expect(displaySerial("discard", "skill", 6)).toBeNull();
  });
  it("hides the serial for a pending card", () => {
    expect(displaySerial("pending", "skill", null)).toBeNull();
  });
});

describe("parseSerialQuery", () => {
  it("accepts a dash, no separator, space, or hash form, case-insensitively", () => {
    expect(parseSerialQuery("SKL-12")).toBe(12);
    expect(parseSerialQuery("skl0012")).toBe(12);
    expect(parseSerialQuery("SKL 12")).toBe(12);
    expect(parseSerialQuery("#12")).toBe(12);
  });
  it("accepts every prefix", () => {
    expect(parseSerialQuery("EXP-1")).toBe(1);
    expect(parseSerialQuery("PLG-1")).toBe(1);
    expect(parseSerialQuery("PRM-1")).toBe(1);
    expect(parseSerialQuery("TOL-1")).toBe(1);
    expect(parseSerialQuery("OTH-1")).toBe(1);
  });
  it("locates by number even when the prefix does not match the card's current type", () => {
    // parseSerialQuery only extracts the number; matching it to a card is the caller's job.
    expect(parseSerialQuery("EXP-12")).toBe(12);
  });
  it("treats a bare number as an ordinary search term, not a serial", () => {
    expect(parseSerialQuery("12")).toBeNull();
  });
  it("returns null for garbage input", () => {
    expect(parseSerialQuery("")).toBeNull();
    expect(parseSerialQuery("hello")).toBeNull();
    expect(parseSerialQuery("SKL-")).toBeNull();
    expect(parseSerialQuery("SKLX-12")).toBeNull();
    expect(parseSerialQuery("#")).toBeNull();
  });
  it("trims surrounding whitespace", () => {
    expect(parseSerialQuery("  SKL-12  ")).toBe(12);
  });
});
