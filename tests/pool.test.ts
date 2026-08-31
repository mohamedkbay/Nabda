import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPostgresPool } from "../src/db/pool.js";

describe("PostgreSQL connection safety limits", () => {
  let pool: Pool | undefined;

  afterEach(async () => {
    await pool?.end();
  });

  it("bounds connection, statement, query, and idle transaction lifetimes", () => {
    pool = createPostgresPool("postgresql://example:example@127.0.0.1:5432/example");
    const options = pool.options as typeof pool.options & {
      statement_timeout: number;
      query_timeout: number;
      lock_timeout: number;
      idle_in_transaction_session_timeout: number;
    };

    expect(options.connectionTimeoutMillis).toBe(5_000);
    expect(options.statement_timeout).toBe(15_000);
    expect(options.query_timeout).toBe(20_000);
    expect(options.lock_timeout).toBe(5_000);
    expect(options.idle_in_transaction_session_timeout).toBe(15_000);
  });
});
