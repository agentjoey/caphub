import type { Pool } from "pg";
import type { ObjectStore } from "../storage/s3";

const KEY_RE = /^sha256\/[a-f0-9]{2}\/([a-f0-9]{64})$/;
const THUMB_KEY_RE = /^thumb\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.webp$/;
const MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

function imageResponse(bytes: Uint8Array, mimeType: string): Response {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "content-type": mimeType,
      "cache-control": "private, max-age=86400, immutable",
      "x-content-type-options": "nosniff"
    }
  });
}

export async function handleObjectRequest(
  key: string,
  deps: { pool: Pick<Pool, "query">; objects: Pick<ObjectStore, "get" | "getThumb"> }
): Promise<Response> {
  const m = KEY_RE.exec(key);
  if (m) {
    const row = (await deps.pool.query<{ mime_type: string | null }>(
      "SELECT mime_type FROM caphub_v2.captures WHERE object_key = $1 LIMIT 1", [key])).rows[0];
    if (!row || !row.mime_type || !MIMES.has(row.mime_type)) return new Response(null, { status: 404 });
    let bytes: Uint8Array;
    try {
      bytes = await deps.objects.get({ key, digest: m[1], bytes: 0 });
    } catch {
      return new Response(null, { status: 410 });
    }
    return imageResponse(bytes, row.mime_type);
  }
  if (THUMB_KEY_RE.test(key)) {
    const row = (await deps.pool.query<{ id: string }>(
      "SELECT id FROM caphub_v2.captures WHERE thumb_key = $1 LIMIT 1", [key])).rows[0];
    if (!row) return new Response(null, { status: 404 });
    let bytes: Uint8Array;
    try {
      bytes = await deps.objects.getThumb(key);
    } catch {
      return new Response(null, { status: 410 });
    }
    return imageResponse(bytes, "image/webp");
  }
  return new Response(null, { status: 404 });
}
