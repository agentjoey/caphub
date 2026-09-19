import type { Pool } from "pg";

export async function topTags(pool: Pick<Pool, "query">, limit = 100): Promise<string[]> {
  const r = await pool.query<{ name: string }>("SELECT name FROM caphub_v2.tags ORDER BY use_count DESC, name LIMIT $1", [limit]);
  return r.rows.map((x) => x.name);
}

export async function bumpTags(pool: Pick<Pool, "query">, tags: string[]): Promise<void> {
  if (!tags.length) return;
  await pool.query(
    "INSERT INTO caphub_v2.tags (name, use_count) SELECT unnest($1::text[]), 1 ON CONFLICT (name) DO UPDATE SET use_count = caphub_v2.tags.use_count + 1",
    [tags]);
}
