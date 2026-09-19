import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { S3Config } from "../config";
import { objectRefFor, objectRefSchema, sha256Hex, type ObjectRef } from "./object-ref";

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

const THUMB_KEY_RE = /^thumb\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.webp$/;

export class ObjectMismatchError extends Error {
  constructor() { super("stored object does not match its content address"); this.name = "ObjectMismatchError"; }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
}

function isPreconditionFailed(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; Code?: unknown; name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return value.code === "PreconditionFailed" || value.Code === "PreconditionFailed"
    || value.name === "PreconditionFailed" || value.$metadata?.httpStatusCode === 412;
}

export class ObjectStore {
  private readonly bucket: string;
  private readonly client: Pick<S3Client, "send">;

  constructor(options: { bucket: string; client: Pick<S3Client, "send"> }) {
    this.bucket = options.bucket;
    this.client = options.client;
  }

  private async head(key: string): Promise<{ bytes: number; digest: string | undefined } | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { bytes: out.ContentLength ?? -1, digest: out.Metadata?.["caphub-sha256"] };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async verifyExisting(key: string, ref: ObjectRef): Promise<void> {
    const existing = await this.head(key);
    if (!existing || existing.bytes !== ref.bytes || existing.digest !== ref.digest) throw new ObjectMismatchError();
  }

  async putIfAbsent(bytes: Uint8Array, mimeType: ImageMime): Promise<ObjectRef> {
    const ref = objectRefFor(bytes);
    const existing = await this.head(ref.key);
    if (existing) {
      if (existing.bytes !== ref.bytes || existing.digest !== ref.digest) throw new ObjectMismatchError();
      return ref;
    }
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket, Key: ref.key, Body: bytes, ContentType: mimeType,
        ContentLength: ref.bytes, Metadata: { "caphub-sha256": ref.digest }, IfNoneMatch: "*"
      }));
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
      await this.verifyExisting(ref.key, ref);
      return ref;
    }
    return ref;
  }

  async get(rawRef: ObjectRef): Promise<Uint8Array> {
    const ref = objectRefSchema.parse(rawRef);
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: ref.key }));
    const bytes = await out.Body!.transformToByteArray();
    if ((ref.bytes !== 0 && bytes.byteLength !== ref.bytes) || sha256Hex(bytes) !== ref.digest) throw new ObjectMismatchError();
    return bytes;
  }

  async deleteExact(key: string): Promise<void> {
    if (!/^sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(key)) throw new Error("INVALID_OBJECT_KEY");
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * Stores a thumbnail at an explicit key (thumb keys are derived from the ORIGINAL image's
   * digest, not the thumbnail bytes, so this can't reuse putIfAbsent's content-addressing).
   * Idempotent: if a thumbnail already exists at the key, this is a no-op — thumbnails
   * carry no per-write retention row, so there is nothing to reconcile on a race.
   */
  async putThumbnail(key: string, bytes: Uint8Array): Promise<void> {
    if (!THUMB_KEY_RE.test(key)) throw new Error("INVALID_THUMB_KEY");
    const existing = await this.head(key);
    if (existing) return;
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket, Key: key, Body: bytes, ContentType: "image/webp",
        ContentLength: bytes.byteLength, IfNoneMatch: "*"
      }));
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
      // Someone else wrote the same thumbnail key concurrently; nothing further to verify.
    }
  }

  /** Fetches a thumbnail's raw bytes. Not content-addressed against its key (see putThumbnail). */
  async getThumb(key: string): Promise<Uint8Array> {
    if (!THUMB_KEY_RE.test(key)) throw new Error("INVALID_THUMB_KEY");
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return out.Body!.transformToByteArray();
  }
}

export function createObjectStore(s3: S3Config, client?: S3Client): ObjectStore {
  const s3Client = client ?? new S3Client({
    endpoint: s3.endpoint, region: s3.region, forcePathStyle: true,
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey }
  });
  return new ObjectStore({ bucket: s3.bucket, client: s3Client });
}
