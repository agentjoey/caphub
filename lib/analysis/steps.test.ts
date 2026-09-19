import { describe, expect, it } from "vitest";
import { recordStep } from "./steps";

describe("recordStep", () => {
  it("strips U+0000 from a nested output value and from error before binding SQL parameters", async () => {
    let params: unknown[] = [];
    const pool = { query: async (_text: string, values: unknown[]) => { params = values; return { rows: [] }; } };
    await recordStep(pool as never, {
      runId: "run_1", step: "search", provider: "minimax", model: "m", attempt: 1,
      durationMs: 10, ok: false, error: "boom\u0000error",
      output: { sources: [{ title: "t", content: "has\u0000nul" }] }
    });
    const [, , , , , , , , , error, output] = params;
    expect(error).toBe("boomerror");
    expect(output).not.toContain("\\u0000");
    expect(JSON.parse(output as string)).toEqual({ sources: [{ title: "t", content: "hasnul" }] });
  });

  it("passes null for output/error when absent", async () => {
    let params: unknown[] = [];
    const pool = { query: async (_text: string, values: unknown[]) => { params = values; return { rows: [] }; } };
    await recordStep(pool as never, { runId: "run_1", step: "vision", provider: "p", model: "m", attempt: 1, durationMs: 1, ok: true });
    const [, , , , , , , , , error, output] = params;
    expect(error).toBeNull();
    expect(output).toBeNull();
  });
});
