import { Pool, type PoolClient, types } from "pg";
import { SCHEMA_SQL } from "./schema";

// Postgres' node driver returns DATE columns as JS Date objects by default,
// which get shifted by the process's local timezone when formatted later —
// a real correctness risk for financial dates (a transaction dated 2024-01-01
// could render as 2023-12-31 depending on server TZ). Keep DATE columns as
// the raw 'YYYY-MM-DD' string Postgres sends instead.
const PG_TYPE_DATE = 1082;
types.setTypeParser(PG_TYPE_DATE, (val: string) => val);

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

let defaultPool: Pool | null = null;

/** The app's shared connection pool, built from DATABASE_URL. */
export function getPool(): Pool {
  if (!defaultPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    defaultPool = createPool(connectionString);
  }
  return defaultPool;
}

/** Idempotent — safe to call before every request. */
export async function ensureSchema(client: Pool | PoolClient): Promise<void> {
  await client.query(SCHEMA_SQL);
}
