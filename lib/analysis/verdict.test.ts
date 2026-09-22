import { describe, expect, it } from "vitest";
import { decideVerdict } from "./verdict";

describe("decideVerdict", () => {
  it("auto-applies confident suggestions", () => {
    expect(decideVerdict({ suggested_verdict: "keep", confidence: 0.8, type: "skill" }, 0.8, { count: 0, unresolved: 0 })).toEqual({ verdict: "keep", by: "auto" });
    expect(decideVerdict({ suggested_verdict: "discard", confidence: 0.95, type: "skill" }, 0.8, { count: 0, unresolved: 0 })).toEqual({ verdict: "discard", by: "auto" });
  });
  it("leaves uncertain ones pending", () => {
    expect(decideVerdict({ suggested_verdict: "keep", confidence: 0.79, type: "skill" }, 0.8, { count: 0, unresolved: 0 })).toEqual({ verdict: "pending", by: null });
  });
  it("sends a prompt card with no verbatim prompt to review even when confident", () => {
    expect(decideVerdict({ suggested_verdict: "keep", confidence: 0.95, type: "prompt" }, 0.8, { count: 0, unresolved: 0 })).toEqual({ verdict: "pending", by: null });
  });
  it("still auto-discards a confident discard with no prompt", () => {
    expect(decideVerdict({ suggested_verdict: "discard", confidence: 0.95, type: "prompt" }, 0.8, { count: 0, unresolved: 0 })).toEqual({ verdict: "discard", by: "auto" });
  });
  it("sends any card with an unresolved prompt to review", () => {
    expect(decideVerdict({ suggested_verdict: "keep", confidence: 0.95, type: "skill" }, 0.8, { count: 1, unresolved: 1 })).toEqual({ verdict: "pending", by: null });
    expect(decideVerdict({ suggested_verdict: "discard", confidence: 0.95, type: "skill" }, 0.8, { count: 0, unresolved: 2 })).toEqual({ verdict: "pending", by: null });
  });
  it("auto-keeps a prompt card that has its verbatim prompt", () => {
    expect(decideVerdict({ suggested_verdict: "keep", confidence: 0.95, type: "prompt" }, 0.8, { count: 1, unresolved: 0 })).toEqual({ verdict: "keep", by: "auto" });
  });
});
