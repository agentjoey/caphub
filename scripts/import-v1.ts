import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { createObjectStore } from "../lib/storage/s3";
import { importV1Captures } from "../lib/import/v1";

const dryRun = !process.argv.includes("--apply");
const config = loadConfig(process.env, "script");
if (!config.s3) throw new Error("S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for import");
const pool = createPool(config.databaseUrl);
importV1Captures({ pool, objects: createObjectStore(config.s3), pipeline: config.pipeline }, { dryRun })
  .then((r) => { console.log(JSON.stringify({ dryRun, imported: r }, null, 2)); return pool.end(); })
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; return pool.end(); });
