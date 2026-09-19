import { describe, expect, it } from "vitest";
import { runReviewTick } from "./reviews";

function fakePool(claimRow: { id: string } | undefined) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const q = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    if (text.includes("FOR UPDATE SKIP LOCKED")) return { rows: claimRow ? [claimRow] : [] };
    return { rows: [] };
  };
  return { calls, pool: { query: q, connect: async () => ({ query: q, release() {} }) } as never };
}
const call = (ok: boolean) => ({ provider: "deepseek", model: "d", invoke: async () => { if (!ok) throw Object.assign(new Error("x"), { code: "TIMEOUT" }); return { value: { agrees: true, points: ["ok"] }, usage: { inputTokens: 1, outputTokens: 1 } }; } });

describe("runReviewTick", () => {
  it("is idle when nothing requested", async () => {
    const { pool } = fakePool(undefined);
    expect(await runReviewTick({ pool, call: call(true), review: async () => ({ agrees: true, points: [] }) }, new AbortController().signal)).toBe("idle");
  });
  it("runs the review and clears the request", async () => {
    const { pool, calls } = fakePool({ id: "cab_1" });
    const seen: string[] = [];
    await runReviewTick({ pool, call: call(true), review: async (_d, id) => { seen.push(id); return { agrees: true, points: [] }; } }, new AbortController().signal);
    expect(seen).toEqual(["cab_1"]);
    expect(calls.some((c) => /review_requested_at = NULL/.test(c.text) && /review_error = NULL/.test(c.text))).toBe(true);
  });
  it("records a readable error and clears the request on failure", async () => {
    const { pool, calls } = fakePool({ id: "cab_1" });
    await runReviewTick({ pool, call: call(true), review: async () => { throw Object.assign(new Error("slow"), { code: "TIMEOUT" }); } }, new AbortController().signal);
    const upd = calls.find((c) => /review_error = \$2/.test(c.text))!;
    expect(upd.values[1]).toBe("TIMEOUT");
  });
});
