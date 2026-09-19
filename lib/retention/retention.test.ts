import { describe, expect, it } from "vitest";
import { sweepRetention } from "./retention";

describe("sweepRetention", () => {
  it("dry-run reports eligible without deleting", async () => {
    const deleted: string[] = [];
    const key = "sha256/aa/" + "a".repeat(64);
    const client = {
      async query(text: string) {
        if (text.startsWith("SELECT object_key FROM caphub_v2.retention")) return { rows: [{ object_key: key }] };
        if (text.startsWith("SELECT 1 FROM caphub_v2.retention")) return { rows: [{ "?column?": 1 }] };
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
        if (text.startsWith("SELECT 1 FROM caphub_v2.retention")) return { rows: [{ "?column?": 1 }] };
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

  it("marks failed and does not update purged_at when deleteExact throws", async () => {
    const key = "sha256/cc/" + "c".repeat(64);
    const errorUpdates: string[] = [];
    const purgedUpdates: string[] = [];
    const client = {
      async query(text: string, params?: unknown[]) {
        if (text.startsWith("SELECT object_key FROM caphub_v2.retention")) return { rows: [{ object_key: key }] };
        if (text.startsWith("SELECT 1 FROM caphub_v2.retention")) return { rows: [{ "?column?": 1 }] };
        if (text.startsWith("UPDATE caphub_v2.retention SET error_code")) { errorUpdates.push(String(params?.[0])); return { rows: [] }; }
        if (text.startsWith("UPDATE caphub_v2.retention SET purged_at")) { purgedUpdates.push(String(params?.[0])); return { rows: [] }; }
        return { rows: [] };
      },
      release() {}
    };
    const pool = { connect: async () => client, query: client.query } as never;
    const out = await sweepRetention({ pool, objects: { deleteExact: async () => { throw new Error("boom"); } } }, { now: new Date(), dryRun: false });
    expect(out).toEqual([{ objectKey: key, state: "failed" }]);
    expect(errorUpdates).toEqual([key]);
    expect(purgedUpdates).toEqual([]);
  });

  it("skips silently, without deleting, when the row is no longer eligible after the lock", async () => {
    const key = "sha256/dd/" + "d".repeat(64);
    const deleted: string[] = [];
    const client = {
      async query(text: string) {
        if (text.startsWith("SELECT object_key FROM caphub_v2.retention")) return { rows: [{ object_key: key }] };
        if (text.startsWith("SELECT 1 FROM caphub_v2.retention")) return { rows: [] };
        return { rows: [] };
      },
      release() {}
    };
    const pool = { connect: async () => client, query: client.query } as never;
    const out = await sweepRetention({ pool, objects: { deleteExact: async (k: string) => { deleted.push(k); } } }, { now: new Date(), dryRun: false });
    expect(out).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("rejects a limit outside 1..25", async () => {
    const pool = { connect: async () => ({ query: async () => ({ rows: [] }), release() {} }), query: async () => ({ rows: [] }) } as never;
    await expect(sweepRetention({ pool, objects: { deleteExact: async () => {} } }, { now: new Date(), dryRun: true, limit: 0 })).rejects.toThrow();
    await expect(sweepRetention({ pool, objects: { deleteExact: async () => {} } }, { now: new Date(), dryRun: true, limit: 26 })).rejects.toThrow();
    await expect(sweepRetention({ pool, objects: { deleteExact: async () => {} } }, { now: new Date(), dryRun: true, limit: 1.5 })).rejects.toThrow();
  });
});
