import "server-only";
import type { Pool } from "pg";
import { loadConfig, type Config } from "./config";
import { createPool } from "./db/pool";
import { createObjectStore, type ObjectStore } from "./storage/s3";

export interface Runtime {
  config: Config;
  pool: Pool;
  objects: ObjectStore;
}

let runtime: Runtime | undefined;

export function getRuntime(): Runtime {
  if (!runtime) {
    const config = loadConfig();
    runtime = { config, pool: createPool(config.databaseUrl), objects: createObjectStore(config.s3) };
  }
  return runtime;
}
