import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { runSeedDemo } from "../lib/seed/demo";

// Fail fast, before touching DATABASE_URL, if the caller didn't opt in explicitly.
if (process.env.SEED_ALLOW !== "1") {
  console.error("Refusing to run: set SEED_ALLOW=1 to seed demo data into DATABASE_URL");
  process.exit(1);
}

const pool = createPool(loadConfig(process.env, "script").databaseUrl);
runSeedDemo(pool, process.env)
  .then((capabilityIds) => { console.log(JSON.stringify({ capabilityIds })); return pool.end(); })
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; return pool.end(); });
