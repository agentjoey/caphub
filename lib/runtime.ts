import "server-only";
import type { Pool } from "pg";
import { loadConfig, type WebConfig } from "./config";
import { createPool } from "./db/pool";
import { createObjectStore, type ObjectStore } from "./storage/s3";

export interface Runtime {
  config: WebConfig;
  pool: Pool;
  objects: ObjectStore;
}

let runtime: Runtime | undefined;

export function getRuntime(): Runtime {
  if (!runtime) {
    const config = loadConfig(process.env, "web");
    runtime = { config, pool: createPool(config.databaseUrl), objects: createObjectStore(config.s3) };
  }
  return runtime;
}
