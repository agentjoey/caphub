import { describe, expect, it } from "vitest";
import { CAPHUB_VERSION } from "./version";

describe("version", () => {
  it("is v2", () => {
    expect(CAPHUB_VERSION.startsWith("2.")).toBe(true);
  });
});
