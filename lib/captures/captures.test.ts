import { describe, expect, it } from "vitest";
import { submitCapture } from "./captures";

function fakePool(existing: { id: string } | null) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      if (text.startsWith("SELECT id FROM caphub_v2.captures")) return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  return { queries, pool: { connect: async () => client } as never };
}

const objects = { putIfAbsent: async () => ({ key: "sha256/ab/" + "a".repeat(64), digest: "a".repeat(64), bytes: 1 }) } as never;

describe("submitCapture", () => {
  it("inserts capture and queued run for new text", async () => {
    const { pool, queries } = fakePool(null);
    const out = await submitCapture({ pool, objects, pipeline: "minimax" }, { source: "web", kind: "text", text: "hi" });
    expect(out.duplicate).toBe(false);
    expect(out.runId).toMatch(/^run_/);
    expect(queries.some((q) => q.text.startsWith("INSERT INTO caphub_v2.captures"))).toBe(true);
    expect(queries.some((q) => q.text.startsWith("INSERT INTO caphub_v2.analysis_runs"))).toBe(true);
  });
  it("returns existing capture on duplicate without enqueuing", async () => {
    const { pool, queries } = fakePool({ id: "cap_existing" });
    const out = await submitCapture({ pool, objects, pipeline: "minimax" }, { source: "web", kind: "text", text: "hi" });
    expect(out).toEqual({ captureId: "cap_existing", runId: null, duplicate: true });
    expect(queries.some((q) => q.text.startsWith("INSERT INTO caphub_v2.analysis_runs"))).toBe(false);
  });
});
