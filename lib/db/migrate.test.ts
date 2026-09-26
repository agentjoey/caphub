import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planMigrations } from "./migrate";

describe("planMigrations", () => {
  it("returns only files not yet applied, sorted", () => {
    const plan = planMigrations(["002_b.sql", "001_a.sql", "003_c.sql"], new Set(["001_a.sql"]));
    expect(plan).toEqual(["002_b.sql", "003_c.sql"]);
  });
  it("rejects files without numeric prefix", () => {
    expect(() => planMigrations(["x.sql"], new Set())).toThrow(/migration name/);
  });

  it("uses an additive migration to null superseded_by when a referenced capability is purged", async () => {
    const migrationsDir = new URL("./migrations/", import.meta.url).pathname;
    const names = (await readdir(migrationsDir)).filter((name) => /^01[0-9]_[a-z0-9_]+\.sql$/.test(name));
    const migrations = await Promise.all(names.map(async (name) => ({ name, sql: await readFile(join(migrationsDir, name), "utf8") })));
    const update = migrations.find(({ name, sql }) => name > "010_status_overlap_deep.sql" && /ON DELETE SET NULL/i.test(sql));

    expect(update).toBeDefined();
    expect(update!.sql).toMatch(/DROP CONSTRAINT(?: IF EXISTS)?\s+capabilities_superseded_by_fkey/i);
    expect(update!.sql).toMatch(/ADD CONSTRAINT\s+capabilities_superseded_by_fkey\s+FOREIGN KEY\s*\(superseded_by\)\s+REFERENCES\s+caphub_v2\.capabilities\s*\(id\)\s+ON DELETE SET NULL/i);
    expect(update!.sql).not.toMatch(/UPDATE\s+caphub_v2\.capabilities/i);
  });
});
