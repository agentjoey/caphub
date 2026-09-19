import type { Pool } from "pg";

export async function findSimilar(pool: Pick<Pool, "query">, text: string, limit = 5): Promise<Array<{ id: string; title: string; tags: string[] }>> {
  const q = text.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!q) return [];
  const r = await pool.query<{ id: string; title: string; tags: string[] }>(
    `SELECT id, title, tags FROM caphub_v2.capabilities
     WHERE verdict = 'keep' AND deleted_at IS NULL AND search @@ plainto_tsquery('simple', $1)
     ORDER BY ts_rank(search, plainto_tsquery('simple', $1)) DESC LIMIT $2`, [q, limit]);
  return r.rows;
}
