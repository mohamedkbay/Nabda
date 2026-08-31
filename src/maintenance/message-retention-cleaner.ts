import type { Pool, PoolClient } from "pg";

const REDACTED_CONTENT = "[redacted]";

export const MESSAGE_RETENTION_SQL = `
  WITH latest_retention AS MATERIALIZED (
    SELECT DISTINCT ON (s.organization_id)
      s.organization_id,
      p.retention_days
    FROM subscriptions s
    JOIN plans p ON p.id = s.plan_id
    ORDER BY
      s.organization_id,
      s.current_period_end DESC,
      s.current_period_start DESC,
      s.created_at DESC,
      s.id DESC
  ), candidates AS MATERIALIZED (
    SELECT m.organization_id, m.id
    FROM messages m
    JOIN latest_retention r ON r.organization_id = m.organization_id
    WHERE m.content_redacted_at IS NULL
      AND m.status IN ('delivered', 'failed', 'expired', 'cancelled')
      AND m.created_at < $1::timestamptz - make_interval(days => r.retention_days)
    ORDER BY m.created_at, m.id
    FOR UPDATE OF m SKIP LOCKED
    LIMIT $2
  ), redacted_deliveries AS (
    UPDATE webhook_deliveries wd
    SET
      payload = jsonb_build_object(
        'redacted', true,
        'message_id', me.message_id,
        'retained_event_type', wd.event_type
      ),
      response_body = NULL,
      last_error = NULL
    FROM message_events me
    JOIN candidates c
      ON c.organization_id = me.organization_id AND c.id = me.message_id
    WHERE wd.organization_id = me.organization_id AND wd.message_event_id = me.id
    RETURNING wd.id
  ), redacted_events AS (
    UPDATE message_events me
    SET
      payload = jsonb_build_object('redacted', true),
      provider_status = NULL,
      provider_event_id = NULL
    FROM candidates c
    WHERE me.organization_id = c.organization_id AND me.message_id = c.id
    RETURNING me.id
  )
  UPDATE messages m
  SET
    content = $3,
    to_number = NULL,
    from_number = NULL,
    metadata = '{}'::jsonb,
    provider_metadata = '{}'::jsonb,
    provider_message_id = NULL,
    provider_status = NULL,
    request_hash = encode(gen_random_bytes(32), 'hex'),
    failure_reason = NULL,
    client_reference = NULL,
    consent_reference = NULL,
    content_redacted_at = clock_timestamp()
  FROM candidates c
  WHERE m.organization_id = c.organization_id AND m.id = c.id
  RETURNING m.id
`;

export class MessageRetentionCleaner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly intervalMs: number,
    private readonly batchSize: number,
    private readonly now: () => Date = () => new Date(),
    private readonly reportError: () => void = () => {
      process.stderr.write("Message retention cleanup failed; it will retry.\n");
    },
  ) {
    if (!Number.isInteger(intervalMs) || intervalMs < 60_000) {
      throw new Error("Message retention cleanup interval must be at least 60000 ms.");
    }
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error("Message retention cleanup batch size must be a positive integer.");
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.trigger(), this.intervalMs);
    this.timer.unref();
    this.trigger();
  }

  private trigger(): void {
    void this.runOnce().catch(() => this.reportError());
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      const result = await client.query<{ id: string }>(MESSAGE_RETENTION_SQL, [
        this.now(),
        this.batchSize,
        REDACTED_CONTENT,
      ]);
      await client.query("COMMIT");
      return result.rowCount ?? result.rows.length;
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client?.release();
      this.running = false;
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
