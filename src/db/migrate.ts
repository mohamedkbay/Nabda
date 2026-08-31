import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { createPostgresPool } from "./pool.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(here, "../../migrations");

export async function migrate(): Promise<void> {
  const config = loadConfig();
  const pool = createPostgresPool(config.DATABASE_URL, config.DB_POOL_MAX);
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query("SELECT pg_advisory_lock(hashtext('nabda-schema-migrations'))");
    const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).sort();
    for (const filename of files) {
      const sql = await readFile(resolve(migrationsDirectory, filename), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE filename = $1",
        [filename],
      );
      if (existing.rowCount) {
        if (existing.rows[0]?.checksum !== checksum) {
          throw new Error(`Applied migration ${filename} has changed.`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [filename, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
      process.stdout.write(`Applied ${filename}\n`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('nabda-schema-migrations'))").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
