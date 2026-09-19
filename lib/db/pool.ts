import { Pool } from "pg";

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 4, ssl: { rejectUnauthorized: true } });
}
