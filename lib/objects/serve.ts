import type { Pool } from "pg";
import type { ObjectStore } from "../storage/s3";

const KEY_RE = /^sha256\/[a-f0-9]{2}\/([a-f0-9]{64})$/;
const MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function handleObjectRequest(
  key: string,
  deps: { pool: Pick<Pool, "query">; objects: Pick<ObjectStore, "get"> }
): Promise<Response> {
  const m = KEY_RE.exec(key);
  if (!m) return new Response(null, { status: 404 });
  const row = (await deps.pool.query<{ mime_type: string | null }>(
    "SELECT mime_type FROM caphub_v2.captures WHERE object_key = $1 LIMIT 1", [key])).rows[0];
  if (!row || !row.mime_type || !MIMES.has(row.mime_type)) return new Response(null, { status: 404 });
  let bytes: Uint8Array;
  try {
    bytes = await deps.objects.get({ key, digest: m[1], bytes: 0 });
  } catch {
    return new Response(null, { status: 410 });
  }
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "content-type": row.mime_type,
      "cache-control": "private, max-age=86400, immutable",
      "x-content-type-options": "nosniff"
    }
  });
}
