import { Pool } from "pg";

export function createPostgresPool(connectionString: string, max = 10): Pool {
  return new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
    application_name: "nabda-api-saas",
  });
}
