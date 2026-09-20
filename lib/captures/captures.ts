import type { Pool } from "pg";
import type { Pipeline } from "../config";
import { newId } from "../ids";
import type { ObjectStore } from "../storage/s3";
import { makeThumbnail, thumbKeyFor } from "../storage/thumbs";
import { dedupeKeyFor, normalizeText, normalizeUrl, type CaptureInput } from "./dedupe";

export interface SubmitResult { captureId: string; runId: string | null; duplicate: boolean }

export async function submitCapture(
  deps: { pool: Pool; objects: ObjectStore; pipeline: Pipeline },
  input: CaptureInput
): Promise<SubmitResult> {
  const dedupeKey = dedupeKeyFor(input);
  const objectRef = input.kind === "image" ? await deps.objects.putIfAbsent(input.bytes, input.mimeType) : null;
  let thumbKey: string | null = null;
  if (input.kind === "image" && objectRef) {
    // Thumbnails make the preview survive the 30-day purge of originals, but they are a
    // convenience, not the submission itself — a failure here (bad image, S3 hiccup) must
    // never block the capture; just leave thumb_key null and log for later backfill.
    try {
      const thumbBytes = await makeThumbnail(input.bytes);
      thumbKey = thumbKeyFor(objectRef.digest);
      await deps.objects.putThumbnail(thumbKey, thumbBytes);
    } catch (error) {
      thumbKey = null;
      console.error(JSON.stringify({
        msg: "thumbnail generation failed", dedupeKey, error: error instanceof Error ? error.message : String(error)
      }));
    }
  }
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
      `INSERT INTO caphub_v2.captures (id, source, kind, object_key, mime_type, text, url, dedupe_key, telegram_chat_id, telegram_message_id, thumb_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [captureId, input.source, input.kind, objectRef?.key ?? null,
        input.kind === "image" ? input.mimeType : null,
        input.kind === "text" ? normalizeText(input.text) : null,
        input.kind === "url" ? normalizeUrl(input.url) : null,
        dedupeKey, input.telegram?.chatId ?? null, input.telegram?.messageId ?? null, thumbKey]
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

/**
 * Links a capture to the Telegram reply message ("已收到，分析中…") sent for it, so a later
 * worker step (Task 4) can edit that same message into the analysis result. This is separate
 * from the `telegram` field on {@link CaptureInput} — that records the *origin* of a capture
 * (unused by the Telegram path, which always submits as anonymous `source: "telegram"` and
 * links the receipt only after a successful, non-duplicate submit).
 */
export async function recordTelegramReceipt(
  pool: Pool,
  captureId: string,
  receipt: { chatId: number; messageId: number }
): Promise<void> {
  await pool.query(
    "UPDATE caphub_v2.captures SET telegram_chat_id = $2, telegram_message_id = $3 WHERE id = $1",
    [captureId, String(receipt.chatId), String(receipt.messageId)]
  );
}

export interface RecentCapture {
  id: string; kind: "image" | "text" | "url"; createdAt: string;
  runState: "queued" | "running" | "done" | "failed" | null;
  capabilityId: string | null; errorCode: string | null;
  objectKey: string | null; thumbKey: string | null; text: string | null; url: string | null;
  title: string | null; verdict: "keep" | "discard" | "pending" | null; deleted: boolean;
}

export async function listRecentCaptures(pool: Pool, limit = 20): Promise<RecentCapture[]> {
  const { rows } = await pool.query<RecentCapture>(
    `SELECT c.id, c.kind, c.created_at AS "createdAt", r.state AS "runState", cb.id AS "capabilityId", r.error_code AS "errorCode",
            c.object_key AS "objectKey", c.thumb_key AS "thumbKey", left(c.text, 140) AS text, c.url, cb.title, cb.verdict, (cb.deleted_at IS NOT NULL) AS deleted
     FROM caphub_v2.captures c
     LEFT JOIN LATERAL (SELECT state, error_code FROM caphub_v2.analysis_runs WHERE capture_id = c.id ORDER BY created_at DESC LIMIT 1) r ON true
     LEFT JOIN caphub_v2.capabilities cb ON cb.capture_id = c.id
     ORDER BY c.created_at DESC LIMIT $1`, [limit]);
  return rows;
}
