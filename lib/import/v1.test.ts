import { describe, expect, it } from "vitest";
import { importV1Captures } from "./v1";

describe("importV1Captures", () => {
  it("submits each v1 capture as an image import and reports duplicates", async () => {
    const key = "sha256/aa/" + "a".repeat(64);
    const pool = { query: async (text: string) => text.includes("caphub.registry_records") ? { rows: [{ record_id: "cap_v1", payload: { object: { key }, mime_type: "image/png" } }] } : { rows: [] } } as never;
    const objects = { get: async () => new Uint8Array([1, 2, 3]) } as never;
    const submitted: unknown[] = [];
    const out = await importV1Captures({ pool, objects, pipeline: "minimax", submit: async (i: unknown) => { submitted.push(i); return { captureId: "cap_new", runId: "run_1", duplicate: false }; } } as never, { dryRun: false });
    expect(out).toEqual([{ v1Id: "cap_v1", captureId: "cap_new", duplicate: false }]);
    expect(submitted[0]).toMatchObject({ source: "import", kind: "image", mimeType: "image/png" });
  });
});
