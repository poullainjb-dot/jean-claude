import path from "node:path";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";

loadEnv({ path: path.resolve(import.meta.dirname, ".env.local") });

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // Tests share one Postgres database and reset it with TRUNCATE between
    // tests — running files in parallel would let one file's truncate race
    // another file's in-flight assertions. Serialize instead.
    fileParallelism: false,
  },
});
