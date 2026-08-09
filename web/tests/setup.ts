import { afterAll, beforeEach } from "vitest";
import { createPool, ensureSchema } from "../src/lib/db";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://portfolio:portfolio_dev_only@localhost:5432/portfolio_test";

export const testPool = createPool(TEST_DATABASE_URL);

beforeEach(async () => {
  const client = await testPool.connect();
  try {
    await ensureSchema(client);
    await client.query("TRUNCATE assets, transactions, prices RESTART IDENTITY CASCADE");
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await testPool.end();
});
