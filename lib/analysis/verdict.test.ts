import { describe, expect, it } from "vitest";
import { decideVerdict } from "./verdict";

describe("decideVerdict", () => {
  it("auto-applies confident suggestions", () => {
    expect(decideVerdict({ suggested_verdict: "keep", confidence: 0.8 }, 0.8)).toEqual({ verdict: "keep", by: "auto" });
    expect(decideVerdict({ suggested_verdict: "discard", confidence: 0.95 }, 0.8)).toEqual({ verdict: "discard", by: "auto" });
  });
  it("leaves uncertain ones pending", () => {
    expect(decideVerdict({ suggested_verdict: "keep", confidence: 0.79 }, 0.8)).toEqual({ verdict: "pending", by: null });
  });
});
