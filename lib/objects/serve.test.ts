import { describe, expect, it } from "vitest";
import { handleObjectRequest } from "./serve";

const KEY = "sha256/ab/" + "a".repeat(64);
const THUMB_KEY = "thumb/sha256/ab/" + "a".repeat(64) + ".webp";
const pool = (rows: unknown[]) => ({ query: async () => ({ rows }) }) as never;
const objects = (bytes: Uint8Array | Error) => ({
  get: async () => { if (bytes instanceof Error) throw bytes; return bytes; },
  getThumb: async () => { if (bytes instanceof Error) throw bytes; return bytes; }
}) as never;

describe("handleObjectRequest", () => {
  it("rejects malformed keys with 404 without touching the db", async () => {
    let queried = false;
    const res = await handleObjectRequest("../etc/passwd", { pool: { query: async () => { queried = true; return { rows: [] }; } } as never, objects: objects(new Uint8Array([1])) });
    expect(res.status).toBe(404);
    expect(queried).toBe(false);
  });
  it("404 when no capture references the key", async () => {
    const res = await handleObjectRequest(KEY, { pool: pool([]), objects: objects(new Uint8Array([1])) });
    expect(res.status).toBe(404);
  });
  it("streams bytes with the capture mime type and private caching", async () => {
    const res = await handleObjectRequest(KEY, { pool: pool([{ mime_type: "image/png" }]), objects: objects(new Uint8Array([1, 2, 3])) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("410 when the object has been purged", async () => {
    const res = await handleObjectRequest(KEY, { pool: pool([{ mime_type: "image/png" }]), objects: objects(new Error("NoSuchKey")) });
    expect(res.status).toBe(410);
  });

  it("404 for a thumb key with no referencing capture", async () => {
    const res = await handleObjectRequest(THUMB_KEY, { pool: pool([]), objects: objects(new Uint8Array([1])) });
    expect(res.status).toBe(404);
  });

  it("streams a thumb key as image/webp when a capture references it", async () => {
    const res = await handleObjectRequest(THUMB_KEY, { pool: pool([{ id: "cap_1" }]), objects: objects(new Uint8Array([9, 8, 7])) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("410 when a referenced thumbnail is missing from the store", async () => {
    const res = await handleObjectRequest(THUMB_KEY, { pool: pool([{ id: "cap_1" }]), objects: objects(new Error("NoSuchKey")) });
    expect(res.status).toBe(410);
  });

  it("rejects malformed thumb-shaped keys with 404 without touching the db", async () => {
    let queried = false;
    const res = await handleObjectRequest("thumb/sha256/ab/not-hex.webp", { pool: { query: async () => { queried = true; return { rows: [] }; } } as never, objects: objects(new Uint8Array([1])) });
    expect(res.status).toBe(404);
    expect(queried).toBe(false);
  });
});
