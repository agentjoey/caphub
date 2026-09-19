import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

const DEFAULT_DIR = new URL("./migrations/", import.meta.url).pathname;

export function planMigrations(files: readonly string[], applied: ReadonlySet<string>): string[] {
  for (const f of files) if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(f)) throw new Error(`invalid migration name: ${f}`);
  return [...files].sort().filter((f) => !applied.has(f));
}

export async function applyMigrations(pool: Pool, dir: string = DEFAULT_DIR): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('caphub_v2.migrate'), 0)");
    await client.query("CREATE SCHEMA IF NOT EXISTS caphub_v2");
    await client.query("CREATE TABLE IF NOT EXISTS caphub_v2.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const applied = new Set((await client.query<{ name: string }>("SELECT name FROM caphub_v2.schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql"));
    const plan = planMigrations(files, applied);
    for (const name of plan) {
      await client.query(await readFile(join(dir, name), "utf8"));
      await client.query("INSERT INTO caphub_v2.schema_migrations (name) VALUES ($1)", [name]);
    }
    await client.query("COMMIT");
    return plan;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
