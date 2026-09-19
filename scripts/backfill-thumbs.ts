import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { createObjectStore } from "../lib/storage/s3";
import { makeThumbnail, thumbKeyFor } from "../lib/storage/thumbs";

const OBJECT_KEY_RE = /^sha256\/[a-f0-9]{2}\/([a-f0-9]{64})$/;

function parseArgs(args: string[]): { apply: boolean } {
  return { apply: args.includes("--apply") };
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env, "script");
  if (!config.s3) throw new Error("S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY required to backfill thumbnails");
  const pool = createPool(config.databaseUrl);
  const objects = createObjectStore(config.s3);
  const log = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`);
  try {
    // Only images whose original hasn't been purged (or was never tracked for retention) can
    // still be read to build a thumbnail; a purged original is gone for good.
    const { rows } = await pool.query<{ id: string; object_key: string }>(
      `SELECT c.id, c.object_key
       FROM caphub_v2.captures c
       LEFT JOIN caphub_v2.retention ret ON ret.object_key = c.object_key
       WHERE c.kind = 'image' AND c.object_key IS NOT NULL AND c.thumb_key IS NULL AND ret.purged_at IS NULL
       ORDER BY c.created_at`
    );
    log({ mode: apply ? "apply" : "dry-run", candidates: rows.length });
    let done = 0;
    let failed = 0;
    for (const row of rows) {
      const m = OBJECT_KEY_RE.exec(row.object_key);
      if (!m) { failed += 1; log({ captureId: row.id, error: "INVALID_OBJECT_KEY" }); continue; }
      const digest = m[1]!;
      try {
        const bytes = await objects.get({ key: row.object_key, digest, bytes: 0 });
        const thumbBytes = await makeThumbnail(bytes);
        const thumbKey = thumbKeyFor(digest);
        if (apply) {
          await objects.putThumbnail(thumbKey, thumbBytes);
          await pool.query("UPDATE caphub_v2.captures SET thumb_key = $1 WHERE id = $2", [thumbKey, row.id]);
        }
        log({ captureId: row.id, thumbKey, applied: apply });
        done += 1;
      } catch (error) {
        failed += 1;
        log({ captureId: row.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    log({ done, failed, mode: apply ? "apply" : "dry-run" });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`backfill-thumbs failed: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
