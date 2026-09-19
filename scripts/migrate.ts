import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { applyMigrations } from "../lib/db/migrate";

const pool = createPool(loadConfig().databaseUrl);
applyMigrations(pool)
  .then((applied) => { console.log(JSON.stringify({ applied })); return pool.end(); })
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; return pool.end(); });
