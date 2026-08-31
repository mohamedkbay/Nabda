import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  MESSAGE_RETENTION_SQL,
  MessageRetentionCleaner,
} from "../src/maintenance/message-retention-cleaner.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");

interface QueryCall {
  text: string;
  values: unknown[] | undefined;
}

class FakeClient {
  readonly calls: QueryCall[] = [];
  readonly release = vi.fn();
  failCleanup = false;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    this.calls.push({ text, values });
    if (text === MESSAGE_RETENTION_SQL) {
      if (this.failCleanup) throw new Error("cleanup failed");
      return {
        rows: [
          { id: "30000000-0000-4000-8000-000000000001" },
          { id: "30000000-0000-4000-8000-000000000002" },
        ] as unknown as Row[],
        rowCount: 2,
      };
    }
    return { rows: [], rowCount: null };
  }
}

function fakePool(client: FakeClient): Pool {
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

describe("MessageRetentionCleaner", () => {
  it("redacts one locked batch in a short transaction", async () => {
    const client = new FakeClient();
    const cleaner = new MessageRetentionCleaner(fakePool(client), 60_000, 25, () => NOW);

    await expect(cleaner.runOnce()).resolves.toBe(2);

    expect(client.calls.map(({ text }) => text)).toEqual(["BEGIN", MESSAGE_RETENTION_SQL, "COMMIT"]);
    expect(client.calls[1]?.values).toEqual([NOW, 25, "[redacted]"]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases the connection when the batch fails", async () => {
    const client = new FakeClient();
    client.failCleanup = true;
    const cleaner = new MessageRetentionCleaner(fakePool(client), 60_000, 25, () => NOW);

    await expect(cleaner.runOnce()).rejects.toThrow("cleanup failed");

    expect(client.calls.map(({ text }) => text)).toEqual(["BEGIN", MESSAGE_RETENTION_SQL, "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("recovers after the pool temporarily cannot provide a connection", async () => {
    const client = new FakeClient();
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error("pool unavailable"))
      .mockResolvedValue(client);
    const pool = { connect } as unknown as Pool;
    const cleaner = new MessageRetentionCleaner(pool, 60_000, 25, () => NOW);

    await expect(cleaner.runOnce()).rejects.toThrow("pool unavailable");
    await expect(cleaner.runOnce()).resolves.toBe(2);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("targets only old terminal, unredacted rows and preserves their records", () => {
    expect(MESSAGE_RETENTION_SQL).toContain("FOR UPDATE OF m SKIP LOCKED");
    expect(MESSAGE_RETENTION_SQL).toContain("m.status IN ('delivered', 'failed', 'expired', 'cancelled')");
    expect(MESSAGE_RETENTION_SQL).toContain("m.content_redacted_at IS NULL");
    expect(MESSAGE_RETENTION_SQL).toContain("m.created_at < $1::timestamptz");
    expect(MESSAGE_RETENTION_SQL).not.toContain("m.updated_at < $1::timestamptz");
    expect(MESSAGE_RETENTION_SQL).toContain("p.retention_days");
    expect(MESSAGE_RETENTION_SQL).toContain("metadata = '{}'::jsonb");
    expect(MESSAGE_RETENTION_SQL).toContain("provider_metadata = '{}'::jsonb");
    expect(MESSAGE_RETENTION_SQL).toContain("request_hash = encode(gen_random_bytes(32), 'hex')");
    expect(MESSAGE_RETENTION_SQL).toContain("to_number = NULL");
    expect(MESSAGE_RETENTION_SQL).toContain("from_number = NULL");
    expect(MESSAGE_RETENTION_SQL).toContain("provider_message_id = NULL");
    expect(MESSAGE_RETENTION_SQL).toContain("UPDATE message_events");
    expect(MESSAGE_RETENTION_SQL).toContain("UPDATE webhook_deliveries");
    expect(MESSAGE_RETENTION_SQL).toContain("response_body = NULL");
    expect(MESSAGE_RETENTION_SQL).toContain("failure_reason = NULL");
    expect(MESSAGE_RETENTION_SQL).toContain("client_reference = NULL");
    expect(MESSAGE_RETENTION_SQL).toContain("consent_reference = NULL");
    expect(MESSAGE_RETENTION_SQL).not.toMatch(/\bDELETE\b/i);
  });
});
