import { handleCreateCapture } from "../../../lib/api/captures";
import { listRecentCaptures, submitCapture } from "../../../lib/captures/captures";
import { getRuntime } from "../../../lib/runtime";
import { wakeWorker } from "../../../lib/worker/wake";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const { pool, objects, config } = getRuntime();
  return handleCreateCapture(request, {
    // A new capture queues an analysis run; wake the worker for it (it doesn't poll while idle).
    submit: async (input) => {
      const result = await submitCapture({ pool, objects, pipeline: config.pipeline }, input);
      wakeWorker("capture");
      return result;
    },
    maxUploadBytes: MAX_UPLOAD_BYTES,
    findCapabilityIdByCapture: async (captureId) => {
      const r = await pool.query<{ id: string }>(
        "SELECT id FROM caphub_v2.capabilities WHERE capture_id = $1 AND deleted_at IS NULL", [captureId]);
      return r.rows[0]?.id ?? null;
    }
  });
}

export async function GET(): Promise<Response> {
  const { pool } = getRuntime();
  return Response.json({ items: await listRecentCaptures(pool) });
}
