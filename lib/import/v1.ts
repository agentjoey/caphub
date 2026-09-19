import type { Pool } from "pg";
import type { Pipeline } from "../config";
import { submitCapture, type SubmitResult } from "../captures/captures";
import type { CaptureInput } from "../captures/dedupe";
import type { ImageMime, ObjectStore } from "../storage/s3";

interface V1Row { record_id: string; payload: { object?: { key?: string }; mime_type?: string } }

export async function importV1Captures(
  deps: { pool: Pool; objects: ObjectStore; pipeline: Pipeline; submit?: (input: CaptureInput) => Promise<SubmitResult> },
  opts: { dryRun: boolean }
): Promise<Array<{ v1Id: string; captureId: string | null; duplicate: boolean; skipped?: string }>> {
  const submit = deps.submit ?? ((input: CaptureInput) => submitCapture({ pool: deps.pool, objects: deps.objects, pipeline: deps.pipeline }, input));
  const rows = (await deps.pool.query<V1Row>(
    `SELECT r.record_id, v.payload FROM caphub.registry_records r
     JOIN caphub.registry_versions v ON v.record_id = r.record_id AND v.version = r.current_version
     WHERE r.kind = 'capture' ORDER BY r.created_at`)).rows;
  const out = [];
  for (const row of rows) {
    const key = row.payload.object?.key;
    const mime = row.payload.mime_type as ImageMime | undefined;
    if (!key || !mime || !["image/png", "image/jpeg", "image/webp"].includes(mime)) { out.push({ v1Id: row.record_id, captureId: null, duplicate: false, skipped: "no image object" }); continue; }
    if (opts.dryRun) { out.push({ v1Id: row.record_id, captureId: null, duplicate: false, skipped: "dry-run" }); continue; }
    let bytes: Uint8Array;
    try { bytes = await deps.objects.get({ key, digest: key.split("/")[2], bytes: 0 }); }
    catch { out.push({ v1Id: row.record_id, captureId: null, duplicate: false, skipped: "object unreadable" }); continue; }
    const r = await submit({ source: "import", kind: "image", bytes, mimeType: mime });
    out.push({ v1Id: row.record_id, captureId: r.captureId, duplicate: r.duplicate });
  }
  return out;
}
