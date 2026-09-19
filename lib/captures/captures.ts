import type { Pool } from "pg";
import type { Pipeline } from "../config";
import { newId } from "../ids";
import type { ObjectStore } from "../storage/s3";
import { dedupeKeyFor, normalizeText, normalizeUrl, type CaptureInput } from "./dedupe";

export interface SubmitResult { captureId: string; runId: string | null; duplicate: boolean }

export async function submitCapture(
  deps: { pool: Pool; objects: ObjectStore; pipeline: Pipeline },
  input: CaptureInput
): Promise<SubmitResult> {
  const dedupeKey = dedupeKeyFor(input);
  const objectRef = input.kind === "image" ? await deps.objects.putIfAbsent(input.bytes, input.mimeType) : null;
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('caphub_v2.capture'), hashtext($1))", [dedupeKey]);
    if (objectRef) {
      // putIfAbsent has (re)stored the object. If it had already been purged, restart its
      // retention window so it is tracked (and purged) again. Runs for duplicates too:
      // re-uploading the same image after its purge hits the dedupe path below.
      await client.query(
        `INSERT INTO caphub_v2.retention (object_key, eligible_at) VALUES ($1, now() + interval '30 days')
         ON CONFLICT (object_key) DO UPDATE SET purged_at = NULL, error_code = NULL, eligible_at = excluded.eligible_at
         WHERE caphub_v2.retention.purged_at IS NOT NULL`,
        [objectRef.key]
      );
    }
    const existing = await client.query<{ id: string }>("SELECT id FROM caphub_v2.captures WHERE dedupe_key = $1", [dedupeKey]);
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return { captureId: existing.rows[0].id, runId: null, duplicate: true };
    }
    const captureId = newId("cap");
    await client.query(
      `INSERT INTO caphub_v2.captures (id, source, kind, object_key, mime_type, text, url, dedupe_key, telegram_chat_id, telegram_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [captureId, input.source, input.kind, objectRef?.key ?? null,
        input.kind === "image" ? input.mimeType : null,
        input.kind === "text" ? normalizeText(input.text) : null,
        input.kind === "url" ? normalizeUrl(input.url) : null,
        dedupeKey, input.telegram?.chatId ?? null, input.telegram?.messageId ?? null]
    );
    const runId = newId("run");
    await client.query(
      "INSERT INTO caphub_v2.analysis_runs (id, capture_id, pipeline, state) VALUES ($1, $2, $3, 'queued')",
      [runId, captureId, deps.pipeline]
    );
    await client.query("COMMIT");
    return { captureId, runId, duplicate: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface RecentCapture {
  id: string; kind: "image" | "text" | "url"; createdAt: string;
  runState: "queued" | "running" | "done" | "failed" | null;
  capabilityId: string | null; errorCode: string | null;
}

export async function listRecentCaptures(pool: Pool, limit = 20): Promise<RecentCapture[]> {
  const { rows } = await pool.query<RecentCapture>(
    `SELECT c.id, c.kind, c.created_at AS "createdAt", r.state AS "runState", cb.id AS "capabilityId", r.error_code AS "errorCode"
     FROM caphub_v2.captures c
     LEFT JOIN LATERAL (SELECT state, error_code FROM caphub_v2.analysis_runs WHERE capture_id = c.id ORDER BY created_at DESC LIMIT 1) r ON true
     LEFT JOIN caphub_v2.capabilities cb ON cb.capture_id = c.id
     ORDER BY c.created_at DESC LIMIT $1`, [limit]);
  return rows;
}
