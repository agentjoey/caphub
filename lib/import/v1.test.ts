import { describe, expect, it } from "vitest";
import { importV1Captures } from "./v1";

function poolWithRow(payload: unknown) {
  return { query: async (text: string) => text.includes("caphub.registry_records") ? { rows: [{ record_id: "cap_v1", payload }] } : { rows: [] } } as never;
}

describe("importV1Captures", () => {
  it("submits each v1 capture as an image import and reports duplicates", async () => {
    const key = "sha256/aa/" + "a".repeat(64);
    const pool = poolWithRow({ object: { key }, mime_type: "image/png" });
    const objects = { get: async () => new Uint8Array([1, 2, 3]) } as never;
    const submitted: unknown[] = [];
    const out = await importV1Captures({ pool, objects, pipeline: "minimax", submit: async (i: unknown) => { submitted.push(i); return { captureId: "cap_new", runId: "run_1", duplicate: false }; } } as never, { dryRun: false });
    expect(out).toEqual([{ v1Id: "cap_v1", captureId: "cap_new", duplicate: false }]);
    expect(submitted[0]).toMatchObject({ source: "import", kind: "image", mimeType: "image/png" });
  });

  it("skips rows with missing or unsupported mime as no image object", async () => {
    const key = "sha256/aa/" + "a".repeat(64);
    const pool = poolWithRow({ object: { key }, mime_type: "application/pdf" });
    const submitted: unknown[] = [];
    const out = await importV1Captures({ pool, objects: {} as never, pipeline: "minimax", submit: async (i: unknown) => { submitted.push(i); return { captureId: "cap_new", runId: "run_1", duplicate: false }; } } as never, { dryRun: false });
    expect(out).toEqual([{ v1Id: "cap_v1", captureId: null, duplicate: false, skipped: "no image object" }]);
    expect(submitted).toHaveLength(0);
  });

  it("skips with dry-run and does not call submit", async () => {
    const key = "sha256/aa/" + "a".repeat(64);
    const pool = poolWithRow({ object: { key }, mime_type: "image/png" });
    const submitted: unknown[] = [];
    const out = await importV1Captures({ pool, objects: {} as never, pipeline: "minimax", submit: async (i: unknown) => { submitted.push(i); return { captureId: "cap_new", runId: "run_1", duplicate: false }; } } as never, { dryRun: true });
    expect(out).toEqual([{ v1Id: "cap_v1", captureId: null, duplicate: false, skipped: "dry-run" }]);
    expect(submitted).toHaveLength(0);
  });

  it("skips malformed keys as invalid object key in both dry-run and apply", async () => {
    const pool = poolWithRow({ object: { key: "not-a-valid-key" }, mime_type: "image/png" });
    const submitted: unknown[] = [];
    const submit = async (i: unknown) => { submitted.push(i); return { captureId: "cap_new", runId: "run_1", duplicate: false }; };

    const dryRunOut = await importV1Captures({ pool, objects: {} as never, pipeline: "minimax", submit } as never, { dryRun: true });
    expect(dryRunOut).toEqual([{ v1Id: "cap_v1", captureId: null, duplicate: false, skipped: "invalid object key" }]);

    const applyOut = await importV1Captures({ pool, objects: {} as never, pipeline: "minimax", submit } as never, { dryRun: false });
    expect(applyOut).toEqual([{ v1Id: "cap_v1", captureId: null, duplicate: false, skipped: "invalid object key" }]);

    expect(submitted).toHaveLength(0);
  });

  it("reports object unreadable with the underlying error message when objects.get throws", async () => {
    const key = "sha256/aa/" + "a".repeat(64);
    const pool = poolWithRow({ object: { key }, mime_type: "image/png" });
    const objects = { get: async () => { throw new Error("NoSuchKey: the object does not exist"); } } as never;
    const submitted: unknown[] = [];
    const out = await importV1Captures({ pool, objects, pipeline: "minimax", submit: async (i: unknown) => { submitted.push(i); return { captureId: "cap_new", runId: "run_1", duplicate: false }; } } as never, { dryRun: false });
    expect(out).toHaveLength(1);
    expect(out[0].v1Id).toBe("cap_v1");
    expect(out[0].captureId).toBeNull();
    expect(out[0].skipped).toMatch(/^object unreadable: /);
    expect(out[0].skipped).toContain("NoSuchKey: the object does not exist");
    expect(submitted).toHaveLength(0);
  });
});
