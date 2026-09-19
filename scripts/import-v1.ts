import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { createObjectStore } from "../lib/storage/s3";
import { importV1Captures } from "../lib/import/v1";

const dryRun = !process.argv.includes("--apply");
const config = loadConfig();
const pool = createPool(config.databaseUrl);
importV1Captures({ pool, objects: createObjectStore(config.s3), pipeline: config.pipeline }, { dryRun })
  .then((r) => { console.log(JSON.stringify({ dryRun, imported: r }, null, 2)); return pool.end(); })
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; return pool.end(); });
