import { describe, expect, it } from "vitest";
import { HeadObjectCommand, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { ObjectStore, ObjectMismatchError } from "./s3";
import { objectRefFor } from "./object-ref";

function fakeClient(store: Map<string, Uint8Array>) {
  return {
    async send(cmd: unknown) {
      if (cmd instanceof HeadObjectCommand) {
        const b = store.get(cmd.input.Key!);
        if (!b) throw Object.assign(new Error("nf"), { $metadata: { httpStatusCode: 404 } });
        return { ContentLength: b.byteLength, Metadata: { "caphub-sha256": cmd.input.Key!.split("/")[2] } };
      }
      if (cmd instanceof PutObjectCommand) { store.set(cmd.input.Key!, cmd.input.Body as Uint8Array); return {}; }
      if (cmd instanceof GetObjectCommand) {
        const b = store.get(cmd.input.Key!)!;
        return { Body: { transformToByteArray: async () => b } };
      }
      throw new Error("unexpected");
    }
  };
}

describe("ObjectStore", () => {
  it("puts once and returns same ref on repeat", async () => {
    const backing = new Map<string, Uint8Array>();
    const store = new ObjectStore({ bucket: "b", client: fakeClient(backing) as never });
    const bytes = new TextEncoder().encode("img");
    const a = await store.putIfAbsent(bytes, "image/png");
    const b = await store.putIfAbsent(bytes, "image/png");
    expect(a).toEqual(b);
    expect(backing.size).toBe(1);
    expect(await store.get(a)).toEqual(bytes);
  });

  it("get with bytes 0 succeeds for correct content and throws on digest mismatch (R5)", async () => {
    const backing = new Map<string, Uint8Array>();
    const store = new ObjectStore({ bucket: "b", client: fakeClient(backing) as never });
    const bytes = new TextEncoder().encode("later-task-payload");
    const ref = await store.putIfAbsent(bytes, "image/png");

    const keyOnlyRef = { key: ref.key, digest: ref.digest, bytes: 0 };
    expect(await store.get(keyOnlyRef)).toEqual(bytes);

    backing.set(ref.key, new TextEncoder().encode("tampered-content"));
    await expect(store.get(keyOnlyRef)).rejects.toBeInstanceOf(ObjectMismatchError);
  });

  it("treats a 412 PreconditionFailed on Put as a concurrent write and verifies the winner (R6)", async () => {
    const bytes = new TextEncoder().encode("race");
    const ref = objectRefFor(bytes);
    let headCalls = 0;

    const client = {
      async send(cmd: unknown) {
        if (cmd instanceof HeadObjectCommand) {
          headCalls += 1;
          if (headCalls === 1) throw Object.assign(new Error("nf"), { $metadata: { httpStatusCode: 404 } });
          return { ContentLength: bytes.byteLength, Metadata: { "caphub-sha256": ref.digest } };
        }
        if (cmd instanceof PutObjectCommand) {
          throw Object.assign(new Error("precondition failed"), { $metadata: { httpStatusCode: 412 } });
        }
        throw new Error("unexpected");
      }
    };

    const store = new ObjectStore({ bucket: "b", client: client as never });
    const result = await store.putIfAbsent(bytes, "image/png");
    expect(result).toEqual(ref);
    expect(headCalls).toBe(2);
  });

  it("putThumbnail stores at the explicit thumb key and getThumb reads it back", async () => {
    const backing = new Map<string, Uint8Array>();
    const store = new ObjectStore({ bucket: "b", client: fakeClient(backing) as never });
    const key = "thumb/sha256/ab/" + "a".repeat(64) + ".webp";
    const bytes = new TextEncoder().encode("thumb-bytes");
    await store.putThumbnail(key, bytes);
    expect(backing.get(key)).toEqual(bytes);
    expect(await store.getThumb(key)).toEqual(bytes);
  });

  it("putThumbnail is idempotent when the key already exists", async () => {
    const backing = new Map<string, Uint8Array>();
    const store = new ObjectStore({ bucket: "b", client: fakeClient(backing) as never });
    const key = "thumb/sha256/ab/" + "a".repeat(64) + ".webp";
    await store.putThumbnail(key, new TextEncoder().encode("first"));
    await store.putThumbnail(key, new TextEncoder().encode("second"));
    expect(backing.get(key)).toEqual(new TextEncoder().encode("first"));
  });

  it("putThumbnail and getThumb reject keys that don't match the thumb pattern", async () => {
    const backing = new Map<string, Uint8Array>();
    const store = new ObjectStore({ bucket: "b", client: fakeClient(backing) as never });
    await expect(store.putThumbnail("sha256/ab/" + "a".repeat(64), new Uint8Array([1]))).rejects.toThrow("INVALID_THUMB_KEY");
    await expect(store.getThumb("sha256/ab/" + "a".repeat(64))).rejects.toThrow("INVALID_THUMB_KEY");
  });

  it("deleteExact refuses to touch a thumb/ key, even one that looks otherwise valid (retention must never purge thumbnails)", async () => {
    const backing = new Map<string, Uint8Array>();
    const store = new ObjectStore({ bucket: "b", client: fakeClient(backing) as never });
    const key = "thumb/sha256/ab/" + "a".repeat(64) + ".webp";
    await store.putThumbnail(key, new TextEncoder().encode("keep-me"));
    await expect(store.deleteExact(key)).rejects.toThrow("INVALID_OBJECT_KEY");
    expect(backing.get(key)).toBeDefined();
  });
});
