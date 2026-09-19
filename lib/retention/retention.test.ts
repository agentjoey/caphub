import { describe, expect, it } from "vitest";
import { sweepRetention } from "./retention";

describe("sweepRetention", () => {
  it("dry-run reports eligible without deleting", async () => {
    const deleted: string[] = [];
    const key = "sha256/aa/" + "a".repeat(64);
    const client = {
      async query(text: string) {
        if (text.startsWith("SELECT object_key FROM caphub_v2.retention")) return { rows: [{ object_key: key }] };
        return { rows: [] };
      },
      release() {}
    };
    const pool = { connect: async () => client, query: client.query } as never;
    const out = await sweepRetention({ pool, objects: { deleteExact: async (k: string) => { deleted.push(k); } } }, { now: new Date(), dryRun: true });
    expect(out).toEqual([{ objectKey: key, state: "eligible" }]);
    expect(deleted).toEqual([]);
  });

  it("non-dry-run deletes the object and marks it purged", async () => {
    const deleted: string[] = [];
    const key = "sha256/bb/" + "b".repeat(64);
    const updates: string[] = [];
    const client = {
      async query(text: string, params?: unknown[]) {
        if (text.startsWith("SELECT object_key FROM caphub_v2.retention")) return { rows: [{ object_key: key }] };
        if (text.startsWith("UPDATE caphub_v2.retention SET purged_at")) { updates.push(String(params?.[0])); return { rows: [] }; }
        return { rows: [] };
      },
      release() {}
    };
    const pool = { connect: async () => client, query: client.query } as never;
    const out = await sweepRetention({ pool, objects: { deleteExact: async (k: string) => { deleted.push(k); } } }, { now: new Date(), dryRun: false });
    expect(out).toEqual([{ objectKey: key, state: "purged" }]);
    expect(deleted).toEqual([key]);
    expect(updates).toEqual([key]);
  });
});
