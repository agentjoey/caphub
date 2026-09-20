import type { Pool } from "pg";
import { parseSerialQuery } from "../library/serial";

type Q = Pick<Pool, "query">;

/**
 * 编号（`SKL-0031` / `#31`）→ 卡片定位。只认 keep + active + 未删除的卡 —— 与所有只读工具的可见性
 * 规则一致（见 tools.ts）。非编号形状的输入（不匹配 {@link parseSerialQuery}）直接返回 null，不查库。
 */
export async function resolveSerial(pool: Q, serial: string): Promise<{ id: string; captureId: string; updatedAt: string } | null> {
  const n = parseSerialQuery(serial);
  if (n === null) return null;
  const r = await pool.query<{ id: string; capture_id: string; updated_at: Date }>(
    `SELECT id, capture_id, updated_at FROM caphub_v2.capabilities
      WHERE serial = $1 AND verdict = 'keep' AND status = 'active' AND deleted_at IS NULL`,
    [n]
  );
  const row = r.rows[0];
  return row ? { id: row.id, captureId: row.capture_id, updatedAt: row.updated_at.toISOString() } : null;
}
