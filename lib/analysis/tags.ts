import type { Pool, PoolClient } from "pg";

export async function topTags(pool: Pick<Pool, "query">, limit = 100): Promise<string[]> {
  const r = await pool.query<{ name: string }>("SELECT name FROM caphub_v2.tags ORDER BY use_count DESC, name LIMIT $1", [limit]);
  return r.rows.map((x) => x.name);
}

/** DISTINCT guards ON CONFLICT DO UPDATE against touching one row twice (PG 21000). */
export async function bumpTags(db: Pick<Pool | PoolClient, "query">, tags: string[]): Promise<void> {
  if (!tags.length) return;
  await db.query(
    "INSERT INTO caphub_v2.tags (name, use_count) SELECT DISTINCT t, 1 FROM unnest($1::text[]) AS t ON CONFLICT (name) DO UPDATE SET use_count = caphub_v2.tags.use_count + 1",
    [tags]);
}
