import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  ApiKeyRecord,
  ContactCursor,
  ContactPage,
  ContactRecord,
  CreateMessageCommand,
  CreateMessageResult,
  DeviceAgentClaimResult,
  DeviceAgentBeginResult,
  DeviceAgentCredentialRecord,
  DeviceAgentEventResult,
  DeviceAgentEventStatus,
  DeviceAgentPrincipal,
  DispatchSlotResult,
  MessageEventRecord,
  MessageExecutionMode,
  MessageRecord,
  OptOutResult,
  OutboxJob,
  QueueSummaryRecord,
  StatusCheckMessage,
  UpsertContactCommand,
  UpsertContactResult,
  UsageRecord,
  WebhookDeliveryRecord,
  WorkerDispatchClaimResult,
} from "../domain/types.js";
import type { Repository } from "./repository.js";

type DbRow = Record<string, unknown>;

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value == null ? null : date(value);
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function mapMessage(row: DbRow): MessageRecord {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    apiKeyId: String(row.api_key_id),
    deviceId: String(row.device_id),
    to: row.to_number == null ? null : String(row.to_number),
    content: String(row.content),
    purpose: row.purpose as MessageRecord["purpose"],
    status: row.status as MessageRecord["status"],
    executionMode: row.execution_mode as MessageExecutionMode,
    clientReference: row.client_reference == null ? null : String(row.client_reference),
    idempotencyKey: String(row.idempotency_key),
    requestHash: String(row.request_hash),
    providerMessageId: row.provider_message_id == null ? null : String(row.provider_message_id),
    failureCode: row.failure_code == null ? null : String(row.failure_code),
    failureReason: row.failure_reason == null ? null : String(row.failure_reason),
    metadata: jsonObject(row.metadata),
    scheduledAt: date(row.scheduled_at),
    expiresAt: date(row.expires_at),
    queuedAt: date(row.queued_at),
    sentAt: nullableDate(row.sent_at),
    deliveredAt: nullableDate(row.delivered_at),
    failedAt: nullableDate(row.failed_at),
    expiredAt: nullableDate(row.expired_at),
    cancelledAt: nullableDate(row.cancelled_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

function mapContact(row: DbRow): ContactRecord {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    createdByApiKeyId: String(row.created_by_api_key_id),
    name: String(row.name),
    phone: String(row.phone_e164),
    consentReference: row.consent_reference == null ? null : String(row.consent_reference),
    tags: stringArray(row.tags),
    metadata: jsonObject(row.metadata),
    deletedAt: nullableDate(row.deleted_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

async function createEventAndDeliveries(
  client: PoolClient,
  message: MessageRecord,
  type: string,
  payload: Record<string, unknown>,
  occurredAt: Date,
  providerEventId?: string,
): Promise<void> {
  const eventPayload = { ...payload, execution_mode: message.executionMode };
  const eventResult = await client.query<DbRow>(`
    INSERT INTO message_events (
      organization_id, message_id, type, status, payload, occurred_at, provider_event_id
    )
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
    RETURNING id, created_at
  `, [
    message.organizationId,
    message.id,
    type,
    message.status,
    JSON.stringify(eventPayload),
    occurredAt,
    providerEventId ?? null,
  ]);
  const event = eventResult.rows[0];
  if (!event) throw new Error("Message event was not created.");
  const eventId = String(event.id);
  const envelope = {
    id: eventId,
    type,
    created_at: date(event.created_at).toISOString(),
    data: {
      message: {
        id: message.id,
        to: message.to,
        status: message.status,
        execution_mode: message.executionMode,
        purpose: message.purpose,
        client_reference: message.clientReference,
        failure: message.failureCode ? { code: message.failureCode, reason: message.failureReason } : null,
        metadata: message.metadata,
        created_at: message.createdAt.toISOString(),
        updated_at: message.updatedAt.toISOString(),
      },
    },
  };
  await client.query(`
    WITH deliveries AS (
      INSERT INTO webhook_deliveries (
        organization_id, webhook_id, message_event_id, event_type, payload
      )
      SELECT w.organization_id, w.id, $2::bigint, $3, $4::jsonb
      FROM webhooks w
      WHERE w.organization_id = $1
        AND w.status = 'active'
        AND ($3 = ANY(w.subscribed_events) OR '*' = ANY(w.subscribed_events))
      ON CONFLICT (organization_id, webhook_id, message_event_id) DO NOTHING
      RETURNING organization_id, id
    )
    INSERT INTO outbox_jobs (
      organization_id, kind, webhook_delivery_id, deduplication_key, payload
    )
    SELECT organization_id, 'webhook.deliver', id, id::text, jsonb_build_object('deliveryId', id)
    FROM deliveries
    ON CONFLICT DO NOTHING
  `, [message.organizationId, eventId, type, JSON.stringify(envelope)]);
}

async function reserveDispatchSlotWithClient(
  client: PoolClient,
  input: {
    organizationId: string;
    deviceId: string;
    messageId: string;
    perMinuteRateLimit: number;
    dispatchMinIntervalMs: number;
    at: Date;
  },
  acquireLocks = true,
): Promise<Exclude<DispatchSlotResult, { kind: "unavailable" }>> {
  if (acquireLocks) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2))", [
      `dispatch-org:${input.organizationId}`,
    ]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2))", [
      `dispatch-device:${input.organizationId}:${input.deviceId}`,
    ]);
  }

  const fences = await client.query<DbRow>(`
    SELECT
      organization_fence.last_message_id AS organization_last_message_id,
      organization_fence.last_dispatch_at AS organization_last_dispatch_at,
      device_fence.last_message_id AS device_last_message_id,
      device_fence.last_dispatch_at AS device_last_dispatch_at,
      history.organization_last_dispatch_at AS history_organization_last_dispatch_at,
      history.device_last_dispatch_at AS history_device_last_dispatch_at
    FROM (SELECT 1) singleton
    LEFT JOIN organization_dispatch_fences organization_fence
      ON organization_fence.organization_id = $1
    LEFT JOIN device_dispatch_fences device_fence
      ON device_fence.organization_id = $1 AND device_fence.device_id = $2
    LEFT JOIN LATERAL (
      SELECT
        max(dispatch_started_at) AS organization_last_dispatch_at,
        max(dispatch_started_at) FILTER (WHERE device_id = $2) AS device_last_dispatch_at
      FROM messages
      WHERE organization_id = $1 AND id <> $3 AND dispatch_started_at IS NOT NULL
    ) history ON true
  `, [input.organizationId, input.deviceId, input.messageId]);
  const row = fences.rows[0];
  if (
    row?.organization_last_message_id != null
    && row.device_last_message_id != null
    && String(row.organization_last_message_id) === input.messageId
    && String(row.device_last_message_id) === input.messageId
  ) return { kind: "reserved", duplicate: true };

  const lastDispatch = [
    nullableDate(row?.organization_last_dispatch_at),
    nullableDate(row?.device_last_dispatch_at),
    nullableDate(row?.history_organization_last_dispatch_at),
    nullableDate(row?.history_device_last_dispatch_at),
  ]
    .filter((candidate): candidate is Date => candidate !== null)
    .sort((left, right) => right.getTime() - left.getTime())[0];
  if (lastDispatch) {
    const planIntervalMs = Math.ceil(60_000 / Math.max(input.perMinuteRateLimit, 1));
    const retryAt = new Date(lastDispatch.getTime() + Math.max(input.dispatchMinIntervalMs, planIntervalMs));
    if (retryAt > input.at) return { kind: "rate_limited", retryAt };
  }

  await client.query(`
    INSERT INTO organization_dispatch_fences (
      organization_id, last_message_id, last_dispatch_at
    ) VALUES ($1, $2, $3)
    ON CONFLICT (organization_id) DO UPDATE SET
      last_message_id = EXCLUDED.last_message_id,
      last_dispatch_at = EXCLUDED.last_dispatch_at,
      updated_at = now()
  `, [input.organizationId, input.messageId, input.at]);
  await client.query(`
    INSERT INTO device_dispatch_fences (
      organization_id, device_id, last_message_id, last_dispatch_at
    ) VALUES ($1, $2, $3, $4)
    ON CONFLICT (organization_id, device_id) DO UPDATE SET
      last_message_id = EXCLUDED.last_message_id,
      last_dispatch_at = EXCLUDED.last_dispatch_at,
      updated_at = now()
  `, [input.organizationId, input.deviceId, input.messageId, input.at]);
  return { kind: "reserved", duplicate: false };
}

export class PostgresRepository implements Repository {
  constructor(
    private readonly pool: Pool,
    private readonly providerMode: "mock" | "httpsms" = "mock",
    private readonly androidAgentEnabled = true,
    private readonly executionMode: MessageExecutionMode = providerMode === "httpsms" ? "live" : "simulation",
  ) {}

  async health(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async findApiKeyByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    const result = await this.pool.query<DbRow>(`
      SELECT ak.id, ak.organization_id, ak.key_hash, ak.scopes, ak.revoked_at, ak.expires_at, o.status AS organization_status
      FROM api_keys ak
      JOIN organizations o ON o.id = ak.organization_id
      WHERE ak.key_prefix = $1
      LIMIT 1
    `, [prefix]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      apiKeyId: String(row.id),
      organizationId: String(row.organization_id),
      organizationStatus: row.organization_status === "active" ? "active" : "suspended",
      scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
      keyHash: String(row.key_hash),
      revokedAt: nullableDate(row.revoked_at),
      expiresAt: nullableDate(row.expires_at),
    };
  }

  async touchApiKey(apiKeyId: string, at: Date): Promise<void> {
    await this.pool.query(`
      UPDATE api_keys SET last_used_at = $2::timestamptz
      WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $2::timestamptz - interval '5 minutes')
    `, [apiKeyId, at]);
  }

  async findDeviceAgentCredentialByPrefix(prefix: string): Promise<DeviceAgentCredentialRecord | null> {
    const result = await this.pool.query<DbRow>(`
      SELECT c.id, c.organization_id, c.device_id, c.token_hash, c.revoked_at, c.mode,
        o.status AS organization_status, d.status AS device_status
      FROM device_agent_credentials c
      JOIN organizations o ON o.id = c.organization_id
      JOIN devices d ON d.organization_id = c.organization_id AND d.id = c.device_id
      WHERE c.token_prefix = $1 AND d.provider = 'android_agent'
      LIMIT 1
    `, [prefix]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      credentialId: String(row.id),
      organizationId: String(row.organization_id),
      deviceId: String(row.device_id),
      organizationStatus: row.organization_status as DeviceAgentCredentialRecord["organizationStatus"],
      deviceStatus: row.device_status as DeviceAgentCredentialRecord["deviceStatus"],
      mode: row.mode as MessageExecutionMode,
      tokenHash: String(row.token_hash),
      revokedAt: nullableDate(row.revoked_at),
    };
  }

  async touchDeviceAgentCredential(credentialId: string, at: Date): Promise<void> {
    await this.pool.query(`
      UPDATE device_agent_credentials SET last_used_at = $2::timestamptz
      WHERE id = $1 AND revoked_at IS NULL
        AND (last_used_at IS NULL OR last_used_at < $2::timestamptz - interval '5 minutes')
    `, [credentialId, at]);
  }

  async heartbeatDeviceAgent(input: {
    principal: DeviceAgentPrincipal;
    telemetry: Record<string, unknown>;
    at: Date;
  }): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE devices d SET
        status = 'active',
        last_seen_at = $4::timestamptz,
        metadata = d.metadata || jsonb_build_object('agent_telemetry', $5::jsonb)
      WHERE d.organization_id = $1 AND d.id = $2
        AND d.provider = 'android_agent' AND d.status IN ('active', 'offline')
        AND EXISTS (
          SELECT 1 FROM device_agent_credentials c
          WHERE c.organization_id = d.organization_id AND c.device_id = d.id
            AND c.id = $3 AND c.mode = $6 AND c.revoked_at IS NULL
        )
    `, [
      input.principal.organizationId,
      input.principal.deviceId,
      input.principal.credentialId,
      input.at,
      JSON.stringify(input.telemetry),
      input.principal.mode,
    ]);
    return Boolean(result.rowCount);
  }

  async claimDeviceAgentMessage(input: {
    principal: DeviceAgentPrincipal;
    leaseTokenHash: string;
    leaseExpiresAt: Date;
    at: Date;
  }): Promise<DeviceAgentClaimResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '10s'");
      const available = await client.query(`
        SELECT 1
        FROM device_agent_credentials c
        JOIN devices d ON d.organization_id = c.organization_id AND d.id = c.device_id
        JOIN organizations o ON o.id = c.organization_id
        WHERE c.id = $1 AND c.organization_id = $2 AND c.device_id = $3
          AND c.mode = $4 AND c.revoked_at IS NULL AND d.provider = 'android_agent'
          AND d.status = 'active' AND o.status = 'active'
        FOR SHARE OF c, d, o
      `, [
        input.principal.credentialId,
        input.principal.organizationId,
        input.principal.deviceId,
        input.principal.mode,
      ]);
      if (!available.rowCount) {
        await client.query("ROLLBACK");
        return { kind: "device_unavailable" };
      }

      const candidates = await client.query<DbRow>(`
        SELECT m.*,
          EXISTS (
            SELECT 1 FROM opt_outs oo
            WHERE oo.organization_id = m.organization_id
              AND oo.channel = 'sms' AND oo.phone_e164 = m.to_number
              AND oo.revoked_at IS NULL
          ) AS recipient_blocked,
          EXISTS (
            SELECT 1 FROM subscriptions s
            JOIN plans p ON p.id = s.plan_id AND p.is_active = true
            WHERE s.organization_id = m.organization_id
              AND s.status IN ('active', 'trialing')
              AND s.current_period_start <= $3 AND s.current_period_end > $3
          ) AS subscription_active
        FROM messages m
        WHERE m.organization_id = $1 AND m.device_id = $2
          AND m.execution_mode = $4
          AND m.status = 'queued' AND m.scheduled_at <= $3
          AND m.dispatch_state = 'pending'
          AND (m.device_lease_expires_at IS NULL OR m.device_lease_expires_at <= $3)
        ORDER BY m.scheduled_at, m.created_at
        FOR UPDATE OF m SKIP LOCKED
        LIMIT 25
      `, [
        input.principal.organizationId,
        input.principal.deviceId,
        input.at,
        input.principal.mode,
      ]);

      for (const row of candidates.rows) {
        let message = mapMessage(row);
        let terminal: "expired" | "cancelled" | null = null;
        let failureCode: string | null = null;
        let failureReason: string | null = null;
        if (message.expiresAt <= input.at) {
          terminal = "expired";
          failureCode = "message_expired";
          failureReason = "The message expired before the Android device claimed it.";
        } else if (row.subscription_active !== true) {
          terminal = "cancelled";
          failureCode = "subscription_inactive";
          failureReason = "Dispatch was cancelled because the subscription is inactive.";
        } else if (row.recipient_blocked === true) {
          terminal = "cancelled";
          failureCode = "recipient_opted_out";
          failureReason = "The recipient opted out before the Android device claimed the message.";
        }

        if (terminal) {
          const terminalResult = await client.query<DbRow>(`
            UPDATE messages SET
              status = $2::message_status,
              dispatch_state = 'completed',
              failure_code = $3,
              failure_reason = $4,
              device_lease_token_hash = NULL,
              device_lease_expires_at = NULL,
              expired_at = CASE WHEN $2::message_status = 'expired' THEN $5 ELSE expired_at END,
              cancelled_at = CASE WHEN $2::message_status = 'cancelled' THEN $5 ELSE cancelled_at END
            WHERE id = $1 RETURNING *
          `, [message.id, terminal, failureCode, failureReason, input.at]);
          message = mapMessage(terminalResult.rows[0] as DbRow);
          await createEventAndDeliveries(client, message, `message.${terminal}`, {
            source: "android_agent",
            reason: failureCode,
          }, input.at);
          continue;
        }

        const claimed = await client.query<DbRow>(`
          UPDATE messages SET
            device_lease_token_hash = $2,
            device_lease_expires_at = $3,
            device_attempt_id = NULL
          WHERE id = $1 RETURNING *
        `, [message.id, input.leaseTokenHash, input.leaseExpiresAt]);
        message = mapMessage(claimed.rows[0] as DbRow);
        await client.query(`
          INSERT INTO message_events (organization_id, message_id, type, status, payload, occurred_at)
          VALUES ($1, $2, 'message.claimed', 'queued', $3::jsonb, $4)
        `, [
          message.organizationId,
          message.id,
          JSON.stringify({
            source: "android_agent",
            execution_mode: message.executionMode,
            lease_expires_at: input.leaseExpiresAt.toISOString(),
          }),
          input.at,
        ]);
        await client.query(`
          INSERT INTO audit_logs (
            organization_id, actor_type, action, resource_type, resource_id, metadata
          ) VALUES ($1, 'system', 'device_agent.message_reserved', 'message', $2, $3::jsonb)
        `, [
          message.organizationId,
          message.id,
          JSON.stringify({ device_id: input.principal.deviceId, credential_id: input.principal.credentialId }),
        ]);
        await client.query("COMMIT");
        return { kind: "claimed", claim: { message, leaseExpiresAt: input.leaseExpiresAt } };
      }

      await client.query("COMMIT");
      return { kind: "empty" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async beginDeviceAgentMessage(input: {
    principal: DeviceAgentPrincipal;
    messageId: string;
    attemptId: string;
    leaseTokenHash: string;
    attemptLeaseExpiresAt: Date;
    dispatchMinIntervalMs: number;
    at: Date;
  }): Promise<DeviceAgentBeginResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '10s'");

      const available = await client.query(`
        SELECT 1
        FROM device_agent_credentials c
        JOIN devices d ON d.organization_id = c.organization_id AND d.id = c.device_id
        JOIN organizations o ON o.id = c.organization_id
        WHERE c.id = $1 AND c.organization_id = $2 AND c.device_id = $3
          AND c.mode = $4 AND c.revoked_at IS NULL AND d.provider = 'android_agent'
          AND d.status = 'active' AND o.status = 'active'
        FOR SHARE OF c, d, o
      `, [
        input.principal.credentialId,
        input.principal.organizationId,
        input.principal.deviceId,
        input.principal.mode,
      ]);
      if (!available.rowCount) {
        await client.query("ROLLBACK");
        return { kind: "not_found" };
      }

      // Resolve the recipient without a row lock, then acquire the same
      // advisory lock used by opt-out and worker dispatch before locking the
      // message row. This ordering prevents a send/opt-out race and deadlock.
      const recipientResult = await client.query<DbRow>(`
        SELECT m.to_number
        FROM messages m
        JOIN devices d ON d.organization_id = m.organization_id AND d.id = m.device_id
        WHERE m.id = $1 AND m.organization_id = $2 AND m.device_id = $3
          AND m.execution_mode = $4 AND d.provider = 'android_agent'
        LIMIT 1
      `, [
        input.messageId,
        input.principal.organizationId,
        input.principal.deviceId,
        input.principal.mode,
      ]);
      const recipient = recipientResult.rows[0]?.to_number;
      if (!recipient) {
        await client.query("ROLLBACK");
        return { kind: "not_found" };
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [
        `recipient:${input.principal.organizationId}:${String(recipient)}`,
      ]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2))", [
        `dispatch-org:${input.principal.organizationId}`,
      ]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2))", [
        `dispatch-device:${input.principal.organizationId}:${input.principal.deviceId}`,
      ]);

      const messageResult = await client.query<DbRow>(`
        SELECT m.*, o.status AS organization_status, d.status AS device_status,
          EXISTS (
            SELECT 1 FROM device_agent_credentials c
            WHERE c.id = $4 AND c.organization_id = m.organization_id
              AND c.device_id = m.device_id AND c.mode = $6 AND c.revoked_at IS NULL
          ) AS credential_active,
          EXISTS (
            SELECT 1 FROM opt_outs oo
            WHERE oo.organization_id = m.organization_id
              AND oo.channel = 'sms' AND oo.phone_e164 = m.to_number
              AND oo.revoked_at IS NULL
          ) AS recipient_blocked,
          (
            SELECT COALESCE(s.per_minute_limit_override, p.per_minute_message_limit)
            FROM subscriptions s
            JOIN plans p ON p.id = s.plan_id AND p.is_active = true
            WHERE s.organization_id = m.organization_id
              AND s.status IN ('active', 'trialing')
              AND s.current_period_start <= $5 AND s.current_period_end > $5
            ORDER BY s.current_period_end DESC
            LIMIT 1
          ) AS plan_rate_limit
        FROM messages m
        JOIN organizations o ON o.id = m.organization_id
        JOIN devices d ON d.organization_id = m.organization_id AND d.id = m.device_id
        WHERE m.id = $1 AND m.organization_id = $2 AND m.device_id = $3
          AND d.provider = 'android_agent'
        FOR UPDATE OF m
      `, [
        input.messageId,
        input.principal.organizationId,
        input.principal.deviceId,
        input.principal.credentialId,
        input.at,
        input.principal.mode,
      ]);
      const row = messageResult.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { kind: "not_found" };
      }
      if (row.device_lease_token_hash == null || String(row.device_lease_token_hash) !== input.leaseTokenHash) {
        await client.query("ROLLBACK");
        return { kind: "invalid_lease" };
      }
      if (row.device_lease_expires_at == null || date(row.device_lease_expires_at) <= input.at) {
        await client.query("ROLLBACK");
        return { kind: "lease_expired" };
      }

      const duplicateAttempt = row.dispatch_state === "processing"
        && row.device_attempt_id === input.attemptId;
      if (row.dispatch_state === "processing" && !duplicateAttempt) {
        await client.query("ROLLBACK");
        return { kind: "invalid_attempt" };
      }
      let message = mapMessage(row);
      if (
        message.status !== "queued"
        || !["pending", "processing"].includes(String(row.dispatch_state))
      ) {
        await client.query("ROLLBACK");
        return { kind: "not_dispatchable", message };
      }

      let terminal: "expired" | "cancelled" | null = null;
      let failureCode: string | null = null;
      let failureReason: string | null = null;
      if (message.expiresAt <= input.at) {
        terminal = "expired";
        failureCode = "message_expired";
        failureReason = "The message expired before the Android sending attempt began.";
      } else if (row.organization_status !== "active") {
        terminal = "cancelled";
        failureCode = "organization_suspended";
        failureReason = "Dispatch was cancelled because the organization is unavailable.";
      } else if (row.plan_rate_limit == null) {
        terminal = "cancelled";
        failureCode = "subscription_inactive";
        failureReason = "Dispatch was cancelled because the subscription is inactive.";
      } else if (row.device_status !== "active" || row.credential_active !== true) {
        terminal = "cancelled";
        failureCode = "device_unavailable";
        failureReason = "Dispatch was cancelled because the Android device credential is unavailable.";
      } else if (row.recipient_blocked === true) {
        terminal = "cancelled";
        failureCode = "recipient_opted_out";
        failureReason = "The recipient opted out before the Android sending attempt began.";
      }
      if (terminal) {
        const terminalResult = await client.query<DbRow>(`
          UPDATE messages SET
            status = $2::message_status,
            dispatch_state = 'completed',
            failure_code = $3,
            failure_reason = $4,
            device_lease_token_hash = NULL,
            device_lease_expires_at = NULL,
            device_attempt_id = NULL,
            expired_at = CASE WHEN $2::message_status = 'expired' THEN $5 ELSE expired_at END,
            cancelled_at = CASE WHEN $2::message_status = 'cancelled' THEN $5 ELSE cancelled_at END
          WHERE id = $1 RETURNING *
        `, [message.id, terminal, failureCode, failureReason, input.at]);
        message = mapMessage(terminalResult.rows[0] as DbRow);
        await createEventAndDeliveries(client, message, `message.${terminal}`, {
          source: "android_agent",
          phase: "begin",
          reason: failureCode,
        }, input.at);
        await client.query("COMMIT");
        return { kind: "not_dispatchable", message };
      }

      // A repeated begin can be caused by a lost HTTP response. Re-run every
      // dynamic safety check before confirming that authorization: consent,
      // expiry and account/device state may have changed since the first begin.
      if (duplicateAttempt) {
        await client.query("COMMIT");
        return {
          kind: "authorized",
          message,
          leaseExpiresAt: date(row.device_lease_expires_at),
          duplicate: true,
        };
      }

      const slot = await reserveDispatchSlotWithClient(client, {
        organizationId: input.principal.organizationId,
        deviceId: input.principal.deviceId,
        messageId: input.messageId,
        perMinuteRateLimit: Number(row.plan_rate_limit),
        dispatchMinIntervalMs: input.dispatchMinIntervalMs,
        at: input.at,
      }, false);
      if (slot.kind === "rate_limited") {
        await client.query("COMMIT");
        return slot;
      }

      const begun = await client.query<DbRow>(`
        UPDATE messages SET
          dispatch_state = 'processing',
          dispatch_started_at = $2,
          attempt_count = attempt_count + 1,
          device_attempt_id = $3,
          device_lease_expires_at = $4
        WHERE id = $1 RETURNING *
      `, [message.id, input.at, input.attemptId, input.attemptLeaseExpiresAt]);
      message = mapMessage(begun.rows[0] as DbRow);
      await client.query(`
        INSERT INTO message_events (organization_id, message_id, type, status, payload, occurred_at)
        VALUES ($1, $2, 'message.dispatching', 'queued', $3::jsonb, $4)
      `, [
        message.organizationId,
        message.id,
        JSON.stringify({
          source: "android_agent",
          execution_mode: message.executionMode,
          attempt_id: input.attemptId,
          lease_expires_at: input.attemptLeaseExpiresAt.toISOString(),
        }),
        input.at,
      ]);
      await client.query(`
        INSERT INTO audit_logs (
          organization_id, actor_type, action, resource_type, resource_id, metadata
        ) VALUES ($1, 'system', 'device_agent.attempt_begun', 'message', $2, $3::jsonb)
      `, [
        message.organizationId,
        message.id,
        JSON.stringify({
          device_id: input.principal.deviceId,
          credential_id: input.principal.credentialId,
          attempt_id: input.attemptId,
        }),
      ]);
      await client.query("COMMIT");
      return {
        kind: "authorized",
        message,
        leaseExpiresAt: input.attemptLeaseExpiresAt,
        duplicate: false,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordDeviceAgentEvent(input: {
    principal: DeviceAgentPrincipal;
    messageId: string;
    eventId: string;
    attemptId: string;
    leaseTokenHash: string;
    requestHash: string;
    requestedStatus: DeviceAgentEventStatus;
    providerMessageId?: string;
    errorCode?: string;
    errorMessage?: string;
    occurredAt: Date;
    at: Date;
  }): Promise<DeviceAgentEventResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '10s'");
      const simulated = input.principal.mode === "simulation";
      const available = await client.query(`
        SELECT 1
        FROM device_agent_credentials c
        JOIN devices d ON d.organization_id = c.organization_id AND d.id = c.device_id
        JOIN organizations o ON o.id = c.organization_id
        WHERE c.id = $1 AND c.organization_id = $2 AND c.device_id = $3
          AND c.mode = $4 AND c.revoked_at IS NULL AND d.provider = 'android_agent'
          AND d.status = 'active' AND o.status = 'active'
        FOR SHARE OF c, d, o
      `, [
        input.principal.credentialId,
        input.principal.organizationId,
        input.principal.deviceId,
        input.principal.mode,
      ]);
      if (!available.rowCount) {
        await client.query("ROLLBACK");
        return { kind: "not_found" };
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 3))", [
        `device-event:${input.principal.organizationId}:${input.eventId}`,
      ]);
      const prior = await client.query<DbRow>(`
        SELECT r.device_id AS receipt_device_id, r.message_id AS receipt_message_id,
          r.lease_token_hash AS receipt_lease_token_hash,
          r.attempt_id AS receipt_attempt_id,
          r.request_hash AS receipt_request_hash, m.*
        FROM device_agent_event_receipts r
        JOIN messages m ON m.organization_id = r.organization_id AND m.id = r.message_id
        WHERE r.organization_id = $1 AND r.event_id = $2
          AND m.execution_mode = $3 AND r.simulated = $4
        LIMIT 1
      `, [input.principal.organizationId, input.eventId, input.principal.mode, simulated]);
      const priorRow = prior.rows[0];
      if (priorRow) {
        await client.query("ROLLBACK");
        if (
          String(priorRow.receipt_device_id) !== input.principal.deviceId
          || String(priorRow.receipt_message_id) !== input.messageId
          || String(priorRow.receipt_attempt_id) !== input.attemptId
        ) return { kind: "event_conflict" };
        if (String(priorRow.receipt_lease_token_hash) !== input.leaseTokenHash) {
          return { kind: "invalid_lease" };
        }
        if (String(priorRow.receipt_request_hash) !== input.requestHash) {
          return { kind: "event_conflict" };
        }
        return { kind: "accepted", message: mapMessage(priorRow), duplicate: true };
      }

      const messageResult = await client.query<DbRow>(`
        SELECT m.*
        FROM messages m
        JOIN devices d ON d.organization_id = m.organization_id AND d.id = m.device_id
        WHERE m.id = $1 AND m.organization_id = $2 AND m.device_id = $3
          AND m.execution_mode = $4 AND d.provider = 'android_agent'
        FOR UPDATE OF m
      `, [
        input.messageId,
        input.principal.organizationId,
        input.principal.deviceId,
        input.principal.mode,
      ]);
      const row = messageResult.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { kind: "not_found" };
      }
      if (row.device_lease_token_hash == null || String(row.device_lease_token_hash) !== input.leaseTokenHash) {
        await client.query("ROLLBACK");
        return { kind: "invalid_lease" };
      }
      if (row.device_lease_expires_at == null || date(row.device_lease_expires_at) <= input.at) {
        await client.query("ROLLBACK");
        return { kind: "lease_expired" };
      }
      if (row.device_attempt_id == null || String(row.device_attempt_id) !== input.attemptId) {
        await client.query("ROLLBACK");
        return { kind: "invalid_lease" };
      }

      const currentStatus = row.status as MessageRecord["status"];
      const validTransition = simulated
        ? currentStatus === "queued" && row.dispatch_state === "processing"
        : currentStatus === "queued" && row.dispatch_state === "processing"
          ? ["sent", "delivered", "failed", "cancelled"].includes(input.requestedStatus)
          : currentStatus === "sent"
            ? ["delivered", "failed"].includes(input.requestedStatus)
            : false;
      if (!validTransition) {
        await client.query("ROLLBACK");
        return { kind: "invalid_transition" };
      }

      const resultingStatus: DeviceAgentEventStatus = simulated ? "cancelled" : input.requestedStatus;
      const providerOutcomeUnknown = !simulated
        && resultingStatus === "failed"
        && ["agent_restart_unknown", "agent_dispatch_failed"].includes(input.errorCode ?? "");
      const failureCode = simulated
        ? "simulation_only"
        : providerOutcomeUnknown
          ? "provider_outcome_unknown"
          : resultingStatus === "failed"
            ? input.errorCode?.slice(0, 100) || "android_agent_failed"
            : resultingStatus === "cancelled"
              ? input.errorCode?.slice(0, 100) || "android_agent_cancelled"
              : null;
      const failureReason = simulated
        ? "Simulation completed without sending an SMS."
        : providerOutcomeUnknown
          ? "The Android agent restarted after dispatch began; the carrier outcome is unknown and requires manual review."
          : failureCode
            ? input.errorMessage?.slice(0, 500) || "The Android agent reported a terminal sending outcome."
            : null;
      const providerStatus = simulated
        ? "simulation_only"
        : providerOutcomeUnknown
          ? "android_agent_outcome_unknown"
          : `android_agent_${input.requestedStatus}`;
      const updatedResult = await client.query<DbRow>(`
        UPDATE messages SET
          status = $4::message_status,
          dispatch_state = CASE WHEN $7 = 'provider_outcome_unknown' THEN 'manual_review' ELSE 'completed' END,
          provider_message_id = COALESCE($5, provider_message_id),
          provider_status = $6,
          failure_code = $7,
          failure_reason = $8,
          sent_at = CASE WHEN $4::message_status IN ('sent', 'delivered') THEN COALESCE(sent_at, $9) ELSE sent_at END,
          delivered_at = CASE WHEN $4::message_status = 'delivered' THEN $9 ELSE delivered_at END,
          failed_at = CASE WHEN $4::message_status = 'failed' THEN $9 ELSE failed_at END,
          cancelled_at = CASE WHEN $4::message_status = 'cancelled' THEN $9 ELSE cancelled_at END,
          device_lease_token_hash = CASE WHEN $4::message_status = 'sent' THEN device_lease_token_hash ELSE NULL END,
          device_lease_expires_at = CASE WHEN $4::message_status = 'sent' THEN device_lease_expires_at ELSE NULL END
        WHERE id = $1 AND organization_id = $2 AND device_id = $3
        RETURNING *
      `, [
        input.messageId,
        input.principal.organizationId,
        input.principal.deviceId,
        resultingStatus,
        simulated ? null : input.providerMessageId?.slice(0, 255) ?? null,
        providerStatus,
        failureCode,
        failureReason,
        input.occurredAt,
      ]);
      const message = mapMessage(updatedResult.rows[0] as DbRow);
      await client.query(`
        INSERT INTO device_agent_event_receipts (
          organization_id, device_id, message_id, event_id, attempt_id, lease_token_hash,
          request_hash, requested_status, resulting_status, simulated, occurred_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::message_status, $9::message_status, $10, $11)
      `, [
        input.principal.organizationId,
        input.principal.deviceId,
        input.messageId,
        input.eventId,
        input.attemptId,
        input.leaseTokenHash,
        input.requestHash,
        input.requestedStatus,
        resultingStatus,
        simulated,
        input.occurredAt,
      ]);
      await createEventAndDeliveries(client, message, `message.${resultingStatus}`, {
        source: "android_agent",
        execution_mode: input.principal.mode,
        simulated,
        device_event_id: input.eventId,
        attempt_id: input.attemptId,
        requested_status: input.requestedStatus,
        provider_status: providerStatus,
      }, input.occurredAt, input.eventId);
      await client.query(`
        INSERT INTO audit_logs (
          organization_id, actor_type, action, resource_type, resource_id, metadata
        ) VALUES ($1, 'system', 'device_agent.message_event', 'message', $2, $3::jsonb)
      `, [
        input.principal.organizationId,
        input.messageId,
        JSON.stringify({
          device_id: input.principal.deviceId,
          credential_id: input.principal.credentialId,
          event_id: input.eventId,
          execution_mode: input.principal.mode,
          simulated,
          requested_status: input.requestedStatus,
          resulting_status: resultingStatus,
        }),
      ]);
      await client.query("COMMIT");
      return { kind: "accepted", message, duplicate: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findIdempotentMessage(organizationId: string, idempotencyKey: string): Promise<MessageRecord | null> {
    const result = await this.pool.query<DbRow>(`
      SELECT * FROM messages WHERE organization_id = $1 AND idempotency_key = $2
    `, [organizationId, idempotencyKey]);
    return result.rows[0] ? mapMessage(result.rows[0]) : null;
  }

  async createMessage(command: CreateMessageCommand): Promise<CreateMessageResult> {
    if (command.executionMode !== this.executionMode) return { kind: "device_unavailable" };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '30s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${command.organizationId}:${command.idempotencyKey}`,
      ]);
      const duplicate = await client.query<DbRow>(`
        SELECT * FROM messages WHERE organization_id = $1 AND idempotency_key = $2
      `, [command.organizationId, command.idempotencyKey]);
      if (duplicate.rows[0]) {
        await client.query("ROLLBACK");
        const message = mapMessage(duplicate.rows[0]);
        return message.requestHash === command.requestHash
          ? { kind: "replayed", message }
          : { kind: "idempotency_conflict" };
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [
        `recipient:${command.organizationId}:${command.to}`,
      ]);

      const subscriptionResult = await client.query<DbRow>(`
        SELECT s.id, s.messages_used,
          COALESCE(s.message_limit_override, p.monthly_message_limit) AS message_limit,
          s.current_period_end
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id AND p.is_active = true
        WHERE s.organization_id = $1
          AND s.status IN ('active', 'trialing')
          AND s.current_period_start <= $2
          AND s.current_period_end > $2
        ORDER BY s.current_period_end DESC
        LIMIT 1
        FOR UPDATE OF s
      `, [command.organizationId, command.consentCapturedAt]);
      const subscription = subscriptionResult.rows[0];
      if (!subscription) {
        await client.query("ROLLBACK");
        return { kind: "subscription_inactive" };
      }
      const used = Number(subscription.messages_used);
      const limit = Number(subscription.message_limit);
      if (used >= limit) {
        await client.query("ROLLBACK");
        return { kind: "quota_exceeded", limit, used, resetsAt: date(subscription.current_period_end) };
      }

      const optedOut = await client.query(`
        SELECT 1 FROM opt_outs
        WHERE organization_id = $1 AND channel = 'sms' AND phone_e164 = $2 AND revoked_at IS NULL
        LIMIT 1
      `, [command.organizationId, command.to]);
      if (optedOut.rowCount) {
        await client.query("ROLLBACK");
        return { kind: "opted_out" };
      }

      const deviceResult = await client.query<DbRow>(`
        SELECT id, sender_number, provider
        FROM devices
        WHERE organization_id = $1 AND status = 'active'
          AND (
            ($2::uuid IS NULL AND (
              (provider = $3 AND $5::boolean)
              OR (
                $4::boolean AND provider = 'android_agent'
                AND EXISTS (
                  SELECT 1 FROM device_agent_credentials c
                  WHERE c.organization_id = devices.organization_id
                    AND c.device_id = devices.id AND c.revoked_at IS NULL
                    AND c.mode = $6
                )
              )
            ))
            OR (
              $2::uuid IS NOT NULL AND id = $2
              AND (
                (provider = $3 AND $5::boolean)
                OR (
                  $4::boolean AND provider = 'android_agent'
                  AND EXISTS (
                    SELECT 1 FROM device_agent_credentials c
                    WHERE c.organization_id = devices.organization_id
                      AND c.device_id = devices.id AND c.revoked_at IS NULL
                      AND c.mode = $6
                  )
                )
              )
            )
          )
        ORDER BY created_at
        LIMIT 1
      `, [
        command.organizationId,
        command.deviceId ?? null,
        this.providerMode,
        this.androidAgentEnabled,
        command.executionMode === (this.providerMode === "httpsms" ? "live" : "simulation"),
        command.executionMode,
      ]);
      const device = deviceResult.rows[0];
      if (!device) {
        await client.query("ROLLBACK");
        return { kind: "device_unavailable" };
      }

      const inserted = await client.query<DbRow>(`
        INSERT INTO messages (
          organization_id, api_key_id, device_id, idempotency_key, request_hash,
          purpose, execution_mode, to_number, from_number, content, client_reference, consent_reference,
          consent_captured_at, metadata, scheduled_at, expires_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16
        ) RETURNING *
      `, [
        command.organizationId,
        command.apiKeyId,
        device.id,
        command.idempotencyKey,
        command.requestHash,
        command.purpose,
        command.executionMode,
        command.to,
        device.sender_number,
        command.content,
        command.clientReference ?? null,
        command.consentReference ?? null,
        command.consentCapturedAt,
        JSON.stringify(command.metadata),
        command.scheduledAt,
        command.expiresAt,
      ]);
      const messageRow = inserted.rows[0];
      if (!messageRow) throw new Error("Message was not created.");
      const message = mapMessage(messageRow);
      await client.query("UPDATE subscriptions SET messages_used = messages_used + 1 WHERE id = $1", [subscription.id]);
      await createEventAndDeliveries(client, message, "message.queued", { source: "api" }, command.consentCapturedAt);
      if (device.provider !== "android_agent") {
        await client.query(`
          INSERT INTO outbox_jobs (
            organization_id, kind, message_id, deduplication_key, payload, available_at
          ) VALUES ($1, 'message.dispatch', $2::uuid, $2::uuid::text, $3::jsonb, $4)
        `, [message.organizationId, message.id, JSON.stringify({
          messageId: message.id,
          executionMode: message.executionMode,
          scheduledAt: message.scheduledAt.toISOString(),
        }), message.scheduledAt]);
      }
      await client.query(`
        INSERT INTO audit_logs (
          organization_id, actor_type, actor_api_key_id, action, resource_type, resource_id, metadata
        ) VALUES ($1, 'api_key', $2, 'message.accepted', 'message', $3, $4::jsonb)
      `, [message.organizationId, command.apiKeyId, message.id, JSON.stringify({
        purpose: message.purpose,
        execution_mode: message.executionMode,
      })]);
      await client.query("COMMIT");
      return { kind: "created", message };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getMessage(organizationId: string, messageId: string): Promise<MessageRecord | null> {
    const result = await this.pool.query<DbRow>(`
      SELECT * FROM messages WHERE organization_id = $1 AND id = $2
    `, [organizationId, messageId]);
    return result.rows[0] ? mapMessage(result.rows[0]) : null;
  }

  async getUsage(organizationId: string, at: Date): Promise<UsageRecord | null> {
    const result = await this.pool.query<DbRow>(`
      SELECT p.code AS plan_code, s.status, s.current_period_start, s.current_period_end,
        s.messages_used,
        COALESCE(s.message_limit_override, p.monthly_message_limit) AS message_limit,
        COALESCE(s.per_minute_limit_override, p.per_minute_message_limit) AS rate_limit,
        p.max_contacts
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id AND p.is_active = true
      WHERE s.organization_id = $1
        AND s.status IN ('active', 'trialing')
        AND s.current_period_start <= $2 AND s.current_period_end > $2
      ORDER BY s.current_period_end DESC
      LIMIT 1
    `, [organizationId, at]);
    const row = result.rows[0];
    if (!row) return null;
    const used = Number(row.messages_used);
    const limit = Number(row.message_limit);
    return {
      planCode: String(row.plan_code),
      subscriptionStatus: String(row.status),
      periodStart: date(row.current_period_start),
      periodEnd: date(row.current_period_end),
      messagesUsed: used,
      messageLimit: limit,
      messagesRemaining: Math.max(limit - used, 0),
      perMinuteRateLimit: Number(row.rate_limit),
      maxContacts: Number(row.max_contacts),
    };
  }

  async addOptOut(input: {
    organizationId: string;
    apiKeyId: string;
    phone: string;
    reason?: string;
    at: Date;
  }): Promise<OptOutResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '30s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [
        `recipient:${input.organizationId}:${input.phone}`,
      ]);
      const inserted = await client.query<DbRow>(`
        INSERT INTO opt_outs (
          organization_id, phone_e164, channel, source, reason, opted_out_at
        ) VALUES ($1, $2, 'sms', 'api', $3, $4)
        ON CONFLICT (organization_id, channel, phone_e164) WHERE revoked_at IS NULL
        DO NOTHING
        RETURNING id
      `, [input.organizationId, input.phone, input.reason?.slice(0, 500) ?? null, input.at]);
      const created = Boolean(inserted.rows[0]);
      const existing = created ? inserted : await client.query<DbRow>(`
        SELECT id FROM opt_outs
        WHERE organization_id = $1 AND channel = 'sms' AND phone_e164 = $2
          AND revoked_at IS NULL
        LIMIT 1
      `, [input.organizationId, input.phone]);
      const optOutId = existing.rows[0]?.id;
      if (!optOutId) throw new Error("The opt-out record was not created.");

      const cancelled = await client.query<DbRow>(`
        UPDATE messages SET
          status = 'cancelled', dispatch_state = 'completed',
          failure_code = 'recipient_opted_out',
          failure_reason = 'The recipient opted out before dispatch.',
          cancelled_at = $3
        WHERE organization_id = $1 AND to_number = $2
          AND status = 'queued' AND dispatch_state = 'pending'
        RETURNING *
      `, [input.organizationId, input.phone, input.at]);
      const cancelledMessageIds: string[] = [];
      for (const row of cancelled.rows) {
        const message = mapMessage(row);
        cancelledMessageIds.push(message.id);
        await createEventAndDeliveries(client, message, "message.cancelled", {
          source: "opt_out",
          opt_out_id: String(optOutId),
        }, input.at);
      }
      await client.query(`
        INSERT INTO audit_logs (
          organization_id, actor_type, actor_api_key_id, action, resource_type, resource_id, metadata
        ) VALUES ($1, 'api_key', $2, $5, 'opt_out', $3, $4::jsonb)
      `, [
        input.organizationId,
        input.apiKeyId,
        optOutId,
        JSON.stringify({ created, cancelled_message_count: cancelledMessageIds.length }),
        created ? "opt_out.created" : "opt_out.confirmed",
      ]);
      await client.query("COMMIT");
      return { id: String(optOutId), created, cancelledMessageIds };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertContact(command: UpsertContactCommand): Promise<UpsertContactResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [
        `contact-limit:${command.organizationId}`,
      ]);
      const capacity = await client.query<{ existing: boolean; active_count: string }>(`
        SELECT
          EXISTS (
            SELECT 1 FROM contacts
            WHERE organization_id = $1 AND phone_e164 = $2 AND deleted_at IS NULL
          ) AS existing,
          (
            SELECT count(*) FROM contacts
            WHERE organization_id = $1 AND deleted_at IS NULL
          ) AS active_count
      `, [command.organizationId, command.phone]);
      const capacityRow = capacity.rows[0];
      if (!capacityRow?.existing && Number(capacityRow?.active_count ?? 0) >= command.maxContacts) {
        await client.query("COMMIT");
        return { kind: "limit_exceeded", limit: command.maxContacts };
      }
      const result = await client.query<DbRow>(`
        INSERT INTO contacts (
          organization_id, created_by_api_key_id, name, phone_e164,
          consent_reference, tags, metadata, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6::text[], $7::jsonb, $8, $8)
        ON CONFLICT (organization_id, phone_e164) WHERE deleted_at IS NULL
        DO UPDATE SET
          name = EXCLUDED.name,
          consent_reference = EXCLUDED.consent_reference,
          tags = EXCLUDED.tags,
          metadata = EXCLUDED.metadata,
          updated_at = EXCLUDED.updated_at
        RETURNING *, (xmax = 0) AS created
      `, [
        command.organizationId,
        command.apiKeyId,
        command.name,
        command.phone,
        command.consentReference ?? null,
        command.tags,
        JSON.stringify(command.metadata),
        command.at,
      ]);
      const row = result.rows[0];
      if (!row) throw new Error("The contact was not created.");
      const contact = mapContact(row);
      const created = row.created === true;
      await client.query(`
        INSERT INTO audit_logs (
          organization_id, actor_type, actor_api_key_id, action, resource_type, resource_id, metadata
        ) VALUES ($1, 'api_key', $2, $3, 'contact', $4, $5::jsonb)
      `, [
        command.organizationId,
        command.apiKeyId,
        created ? "contact.created" : "contact.updated",
        contact.id,
        JSON.stringify({
          tags_count: contact.tags.length,
          has_consent_reference: contact.consentReference !== null,
        }),
      ]);
      await client.query("COMMIT");
      return { kind: "upserted", contact, created };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listContacts(input: {
    organizationId: string;
    limit: number;
    cursor: ContactCursor | null;
  }): Promise<ContactPage> {
    const result = await this.pool.query<DbRow>(`
      SELECT *
      FROM contacts
      WHERE organization_id = $1
        AND deleted_at IS NULL
        AND (
          $3::timestamptz IS NULL
          OR created_at < $3::timestamptz
          OR (created_at = $3::timestamptz AND id < $4::uuid)
        )
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `, [
      input.organizationId,
      input.limit + 1,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
    ]);
    const hasMore = result.rows.length > input.limit;
    const contacts = result.rows.slice(0, input.limit).map(mapContact);
    const last = contacts.at(-1);
    return {
      contacts,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }

  async deleteContact(input: {
    organizationId: string;
    apiKeyId: string;
    contactId: string;
    at: Date;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<DbRow>(`
        DELETE FROM contacts
        WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
        RETURNING id
      `, [input.organizationId, input.contactId]);
      const contact = result.rows[0];
      if (!contact) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(`
        INSERT INTO audit_logs (
          organization_id, actor_type, actor_api_key_id, action, resource_type, resource_id, metadata
        ) VALUES ($1, 'api_key', $2, 'contact.deleted', 'contact', $3, $4::jsonb)
      `, [
        input.organizationId,
        input.apiKeyId,
        input.contactId,
        JSON.stringify({ contact_data_deleted: true, deleted_at: input.at.toISOString() }),
      ]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getQueueSummary(organizationId: string, at: Date): Promise<QueueSummaryRecord> {
    const result = await this.pool.query<DbRow>(`
      SELECT
        count(*) FILTER (WHERE status = 'queued') AS queued_total,
        count(*) FILTER (
          WHERE status = 'queued' AND dispatch_state = 'pending' AND scheduled_at <= $2
        ) AS ready,
        count(*) FILTER (
          WHERE status = 'queued' AND dispatch_state = 'pending' AND scheduled_at > $2
        ) AS scheduled,
        count(*) FILTER (
          WHERE status = 'queued' AND dispatch_state = 'processing'
        ) AS processing,
        min(queued_at) FILTER (WHERE status = 'queued') AS oldest_queued_at
      FROM messages
      WHERE organization_id = $1
    `, [organizationId, at]);
    const row = result.rows[0];
    return {
      queuedTotal: Number(row?.queued_total ?? 0),
      ready: Number(row?.ready ?? 0),
      scheduled: Number(row?.scheduled ?? 0),
      processing: Number(row?.processing ?? 0),
      oldestQueuedAt: nullableDate(row?.oldest_queued_at),
    };
  }

  async claimOutboxJobs(limit: number, lockId: string, now: Date): Promise<OutboxJob[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const expiredQueued = await client.query<DbRow>(`
        WITH expiring AS (
          SELECT id FROM messages
          WHERE status = 'queued' AND dispatch_state = 'pending'
            AND expires_at <= $1::timestamptz
          ORDER BY expires_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 100
        )
        UPDATE messages m SET
          status = 'expired', dispatch_state = 'completed',
          failure_code = 'message_expired',
          failure_reason = 'The message expired before dispatch.',
          device_lease_token_hash = NULL,
          device_lease_expires_at = NULL,
          expired_at = $1::timestamptz
        FROM expiring e
        WHERE m.id = e.id
        RETURNING m.*
      `, [now]);
      for (const row of expiredQueued.rows) {
        const message = mapMessage(row);
        await createEventAndDeliveries(client, message, "message.expired", {
          source: "system",
          reason: "message_expired",
        }, now);
      }
      const stalledDispatches = await client.query<DbRow>(`
        WITH stalled AS (
          SELECT id FROM messages
          WHERE status = 'queued' AND dispatch_state = 'processing'
            AND dispatch_started_at < $1::timestamptz - interval '15 minutes'
          ORDER BY dispatch_started_at
          FOR UPDATE SKIP LOCKED
          LIMIT 100
        )
        UPDATE messages m SET
          status = 'failed', dispatch_state = 'manual_review',
          failure_code = 'worker_outcome_unknown',
          failure_reason = 'The worker stopped before the provider outcome was persisted; manual review is required.',
          failed_at = $1::timestamptz
        FROM stalled s
        WHERE m.id = s.id
        RETURNING m.*
      `, [now]);
      for (const row of stalledDispatches.rows) {
        const message = mapMessage(row);
        await createEventAndDeliveries(client, message, "message.failed", {
          source: "system",
          reason: "stalled_dispatch",
        }, now);
      }
      await client.query(`
        UPDATE webhook_deliveries SET status = 'pending', locked_at = NULL, locked_by = NULL,
          next_attempt_at = $1::timestamptz, last_error = 'The previous delivery lease expired before completion.'
        WHERE status = 'processing' AND locked_at < $1::timestamptz - interval '5 minutes'
          AND attempt_count < max_attempts
      `, [now]);
      await client.query(`
        UPDATE webhook_deliveries SET status = 'dead', locked_at = NULL, locked_by = NULL,
          last_error = COALESCE(last_error, 'Webhook delivery attempts were exhausted.')
        WHERE status = 'processing' AND locked_at < $1::timestamptz - interval '5 minutes'
          AND attempt_count >= max_attempts
      `, [now]);
      await client.query(`
        UPDATE outbox_jobs o
        SET status = 'pending', completed_at = NULL, available_at = $1::timestamptz
        FROM messages m
        WHERE o.kind = 'message.dispatch' AND o.message_id = m.id
          AND o.organization_id = m.organization_id AND o.status = 'completed'
          AND o.completed_at < $1::timestamptz - interval '5 minutes'
          AND m.status = 'queued' AND m.dispatch_state = 'pending' AND m.scheduled_at <= $1::timestamptz
      `, [now]);
      await client.query(`
        UPDATE outbox_jobs o
        SET status = 'pending', completed_at = NULL, available_at = $1::timestamptz
        FROM webhook_deliveries d
        WHERE o.kind = 'webhook.deliver' AND o.webhook_delivery_id = d.id
          AND o.organization_id = d.organization_id AND o.status = 'completed'
          AND o.completed_at < $1::timestamptz - interval '5 minutes'
          AND d.status = 'pending' AND d.next_attempt_at <= $1::timestamptz
      `, [now]);
      await client.query(`
        UPDATE outbox_jobs SET status = 'pending', locked_at = NULL, locked_by = NULL
        WHERE status = 'processing' AND locked_at < $1::timestamptz - interval '5 minutes' AND attempts < max_attempts
      `, [now]);
      const exhausted = await client.query<DbRow>(`
        SELECT id, kind, message_id, webhook_delivery_id
        FROM outbox_jobs
        WHERE attempts >= max_attempts AND status IN ('pending', 'processing')
          AND (locked_at IS NULL OR locked_at < $1::timestamptz - interval '5 minutes')
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 100
      `, [now]);
      for (const job of exhausted.rows) {
        if (job.kind === "message.dispatch" && job.message_id) {
          const failed = await client.query<DbRow>(`
            UPDATE messages SET status = 'failed', dispatch_state = 'manual_review',
              failure_code = 'queue_publish_failed',
              failure_reason = 'The dispatch job could not be published after repeated attempts.',
              failed_at = $2
            WHERE id = $1 AND status = 'queued' AND dispatch_state = 'pending'
            RETURNING *
          `, [job.message_id, now]);
          if (failed.rows[0]) {
            const message = mapMessage(failed.rows[0]);
            await createEventAndDeliveries(client, message, "message.failed", {
              source: "system",
              reason: "outbox_exhausted",
            }, now);
          }
        } else if (job.kind === "webhook.deliver" && job.webhook_delivery_id) {
          await client.query(`
            UPDATE webhook_deliveries SET status = 'dead',
              last_error = 'The webhook job could not be published after repeated attempts.'
            WHERE id = $1 AND status IN ('pending', 'processing')
          `, [job.webhook_delivery_id]);
        }
        await client.query(`
          UPDATE outbox_jobs SET status = 'dead', locked_at = NULL, locked_by = NULL,
            last_error = COALESCE(last_error, 'Outbox publishing attempts were exhausted.')
          WHERE id = $1
        `, [job.id]);
      }
      const result = await client.query<DbRow>(`
        WITH candidates AS (
          SELECT id FROM outbox_jobs
          WHERE status = 'pending' AND available_at <= $1::timestamptz AND attempts < max_attempts
          ORDER BY available_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        )
        UPDATE outbox_jobs j
        SET status = 'processing', locked_at = $1::timestamptz, locked_by = $3, attempts = attempts + 1
        FROM candidates c
        WHERE j.id = c.id
        RETURNING j.id, j.kind, j.aggregate_id, j.payload, j.attempts
      `, [now, limit, lockId]);
      await client.query("COMMIT");
      return result.rows.map((row) => ({
        id: String(row.id),
        kind: row.kind as OutboxJob["kind"],
        aggregateId: String(row.aggregate_id),
        payload: jsonObject(row.payload),
        attempts: Number(row.attempts),
      }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markOutboxPublished(outboxId: string, lockId: string, at: Date): Promise<void> {
    await this.pool.query(`
      UPDATE outbox_jobs
      SET status = 'completed', completed_at = $3, locked_at = NULL, locked_by = NULL
      WHERE id = $1 AND locked_by = $2 AND status = 'processing'
    `, [outboxId, lockId, at]);
  }

  async releaseOutboxJob(outboxId: string, lockId: string, availableAt: Date, error: string): Promise<void> {
    await this.pool.query(`
      UPDATE outbox_jobs
      SET status = 'pending', available_at = $3, locked_at = NULL, locked_by = NULL, last_error = $4
      WHERE id = $1 AND locked_by = $2 AND status = 'processing'
    `, [outboxId, lockId, availableAt, error.slice(0, 500)]);
  }

  async claimMessageForDispatch(input: {
    messageId: string;
    dispatchMinIntervalMs: number;
    at: Date;
  }): Promise<WorkerDispatchClaimResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '10s'");
      const identity = await client.query<DbRow>(`
        SELECT organization_id, device_id, to_number
        FROM messages
        WHERE id = $1
        LIMIT 1
      `, [input.messageId]);
      const identityRow = identity.rows[0];
      if (!identityRow) {
        await client.query("ROLLBACK");
        return { kind: "terminal" };
      }
      const organizationId = String(identityRow.organization_id);
      const deviceId = String(identityRow.device_id);
      const phone = String(identityRow.to_number);
      // The opt-out path takes this same recipient lock before cancelling
      // pending messages. Committing processing defines the send/opt-out order,
      // so no database connection needs to remain open during provider I/O.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [
        `recipient:${organizationId}:${phone}`,
      ]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2))", [
        `dispatch-org:${organizationId}`,
      ]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2))", [
        `dispatch-device:${organizationId}:${deviceId}`,
      ]);
      const result = await client.query<DbRow>(`
        SELECT m.*, d.provider AS device_provider, d.sender_number AS device_sender_number,
          d.encrypted_config AS device_encrypted_config, d.status AS device_status,
          o.status AS organization_status,
          EXISTS (
            SELECT 1 FROM opt_outs oo
            WHERE oo.organization_id = m.organization_id
              AND oo.channel = 'sms' AND oo.phone_e164 = m.to_number
              AND oo.revoked_at IS NULL
          ) AS recipient_blocked,
          (
            SELECT COALESCE(s.per_minute_limit_override, p.per_minute_message_limit)
            FROM subscriptions s
            JOIN plans p ON p.id = s.plan_id AND p.is_active = true
            WHERE s.organization_id = m.organization_id
              AND s.status IN ('active', 'trialing')
              AND s.current_period_start <= $2 AND s.current_period_end > $2
            ORDER BY s.current_period_end DESC
            LIMIT 1
          ) AS plan_rate_limit
        FROM messages m
        JOIN devices d ON d.organization_id = m.organization_id AND d.id = m.device_id
        JOIN organizations o ON o.id = m.organization_id
        WHERE m.id = $1 AND m.status = 'queued' AND m.dispatch_state = 'pending'
          AND m.scheduled_at <= $2
        FOR UPDATE OF m
      `, [input.messageId, input.at]);
      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { kind: "terminal" };
      }
      // Android devices pull directly from PostgreSQL through the authenticated
      // lease protocol. The BullMQ notification must not claim or cancel them.
      if (row.device_provider === "android_agent" && this.androidAgentEnabled) {
        await client.query("ROLLBACK");
        return { kind: "terminal" };
      }
      let message = mapMessage(row);
      let terminal: "expired" | "cancelled" | null = null;
      let failureCode: string | null = null;
      if (message.expiresAt <= input.at) {
        terminal = "expired";
        failureCode = "message_expired";
      } else if (row.organization_status !== "active") {
        terminal = "cancelled";
        failureCode = "organization_suspended";
      } else if (row.plan_rate_limit == null) {
        terminal = "cancelled";
        failureCode = "subscription_inactive";
      } else if (row.device_status !== "active") {
        terminal = "cancelled";
        failureCode = "device_unavailable";
      } else if (message.executionMode !== this.executionMode) {
        terminal = "cancelled";
        failureCode = "execution_mode_mismatch";
      } else if (row.device_provider !== this.providerMode) {
        terminal = "cancelled";
        failureCode = "provider_mode_mismatch";
      } else if (row.recipient_blocked === true) {
        terminal = "cancelled";
        failureCode = "recipient_opted_out";
      }
      if (terminal) {
        const updated = await client.query<DbRow>(`
          UPDATE messages SET status = $2::message_status, dispatch_state = 'completed', failure_code = $3,
            failure_reason = $4,
            expired_at = CASE WHEN $2::message_status = 'expired' THEN $5 ELSE expired_at END,
            cancelled_at = CASE WHEN $2::message_status = 'cancelled' THEN $5 ELSE cancelled_at END
          WHERE id = $1 RETURNING *
        `, [
          message.id,
          terminal,
          failureCode,
          terminal === "expired"
            ? "The message expired before dispatch."
            : failureCode === "recipient_opted_out"
              ? "The recipient opted out before dispatch."
              : failureCode === "execution_mode_mismatch"
                ? "Dispatch was cancelled because the message execution mode does not match this worker."
              : "Dispatch was cancelled because the organization or device is unavailable.",
          input.at,
        ]);
        message = mapMessage(updated.rows[0] as DbRow);
        await createEventAndDeliveries(client, message, `message.${terminal}`, { source: "worker" }, input.at);
        await client.query("COMMIT");
        return { kind: "terminal" };
      }
      const slot = await reserveDispatchSlotWithClient(client, {
        organizationId: message.organizationId,
        deviceId: message.deviceId,
        messageId: message.id,
        perMinuteRateLimit: Number(row.plan_rate_limit),
        dispatchMinIntervalMs: input.dispatchMinIntervalMs,
        at: input.at,
      }, false);
      if (slot.kind === "rate_limited") {
        await client.query("COMMIT");
        return slot;
      }
      const claimed = await client.query<DbRow>(`
        UPDATE messages
        SET dispatch_state = 'processing', dispatch_started_at = $2, attempt_count = attempt_count + 1
        WHERE id = $1 RETURNING *
      `, [message.id, input.at]);
      message = mapMessage(claimed.rows[0] as DbRow);
      await client.query(`
        INSERT INTO message_events (organization_id, message_id, type, status, payload, occurred_at)
        VALUES ($1, $2, 'message.dispatching', 'queued', $3::jsonb, $4)
      `, [message.organizationId, message.id, JSON.stringify({
        source: "worker",
        execution_mode: message.executionMode,
      }), input.at]);
      await client.query("COMMIT");
      if (!message.to) {
        throw new Error("A dispatchable message is missing its retained recipient.");
      }
      return {
        kind: "claimed",
        message: {
          ...message,
          to: message.to,
          device: {
            provider: row.device_provider as "mock" | "httpsms",
            senderNumber: row.device_sender_number == null ? null : String(row.device_sender_number),
            encryptedConfig: row.device_encrypted_config == null ? null : String(row.device_encrypted_config),
          },
        },
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeMessageDispatch(input: {
    messageId: string;
    status: "sent" | "delivered" | "failed" | "cancelled";
    providerMessageId?: string;
    providerStatus?: string;
    failureCode?: string;
    failureReason?: string;
    at: Date;
  }): Promise<MessageRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<DbRow>(`
        UPDATE messages SET
          status = $2::message_status,
          dispatch_state = CASE WHEN $2::message_status = 'failed' AND $4 = 'provider_outcome_unknown' THEN 'manual_review' ELSE 'completed' END,
          provider_message_id = COALESCE($3, provider_message_id),
          provider_status = COALESCE($7, provider_status),
          failure_code = $4,
          failure_reason = $5,
          sent_at = CASE WHEN $2::message_status IN ('sent', 'delivered') THEN $6 ELSE sent_at END,
          delivered_at = CASE WHEN $2::message_status = 'delivered' THEN $6 ELSE delivered_at END,
          failed_at = CASE WHEN $2::message_status = 'failed' THEN $6 ELSE failed_at END,
          cancelled_at = CASE WHEN $2::message_status = 'cancelled' THEN $6 ELSE cancelled_at END
        WHERE id = $1 AND status = 'queued' AND dispatch_state = 'processing'
        RETURNING *
      `, [
        input.messageId,
        input.status,
        input.providerMessageId ?? null,
        input.failureCode ?? null,
        input.failureReason?.slice(0, 500) ?? null,
        input.at,
        input.providerStatus?.slice(0, 100) ?? null,
      ]);
      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      const message = mapMessage(row);
      await createEventAndDeliveries(client, message, `message.${input.status}`, {
        source: "worker",
        ...(input.providerStatus ? { provider_status: input.providerStatus.slice(0, 100) } : {}),
      }, input.at);
      await client.query("COMMIT");
      return message;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimMessagesForStatusCheck(limit: number, at: Date): Promise<StatusCheckMessage[]> {
    const result = await this.pool.query<DbRow>(`
      WITH candidates AS (
        SELECT m.id FROM messages m
        JOIN devices candidate_device
          ON candidate_device.organization_id = m.organization_id AND candidate_device.id = m.device_id
        WHERE m.status = 'sent'
          AND m.execution_mode = $3
          AND (
            (candidate_device.provider = 'android_agent' AND m.expires_at <= $1::timestamptz)
            OR (
              candidate_device.provider <> 'android_agent'
              AND m.provider_message_id IS NOT NULL
              AND (
                m.last_status_checked_at IS NULL
                OR m.last_status_checked_at < $1::timestamptz - make_interval(
                  secs => LEAST(1800, 30 * (2 ^ LEAST(m.status_check_count, 6)))::double precision
                )
              )
            )
          )
        ORDER BY
          CASE WHEN m.expires_at <= $1::timestamptz THEN 0 ELSE 1 END,
          COALESCE(m.last_status_checked_at, m.sent_at), m.sent_at
        FOR UPDATE SKIP LOCKED
        LIMIT $2
      ), claimed AS (
        UPDATE messages m SET
          last_status_checked_at = $1::timestamptz,
          status_check_count = status_check_count + 1
        FROM candidates c
        WHERE m.id = c.id
        RETURNING m.id, m.organization_id, m.status, m.provider_message_id, m.expires_at, m.device_id
      )
      SELECT c.*, d.provider AS device_provider, d.encrypted_config AS device_encrypted_config
      FROM claimed c
      JOIN devices d ON d.organization_id = c.organization_id AND d.id = c.device_id
    `, [at, limit, this.executionMode]);
    return result.rows.map((row) => ({
      id: String(row.id),
      organizationId: String(row.organization_id),
      status: "sent",
      providerMessageId: row.provider_message_id == null ? null : String(row.provider_message_id),
      expiresAt: date(row.expires_at),
      device: {
        provider: row.device_provider as "mock" | "httpsms" | "android_agent",
        encryptedConfig: row.device_encrypted_config == null ? null : String(row.device_encrypted_config),
      },
    }));
  }

  async completeMessageStatusCheck(input: {
    messageId: string;
    status: "sent" | "delivered" | "failed" | "expired";
    providerStatus: string;
    failureReason?: string;
    at: Date;
  }): Promise<MessageRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<DbRow>(`
        UPDATE messages SET
          status = $2::message_status,
          provider_status = $3,
          failure_code = CASE WHEN $2::message_status = 'failed' THEN 'provider_failed' WHEN $2::message_status = 'expired' THEN 'provider_expired' ELSE failure_code END,
          failure_reason = CASE WHEN $2::message_status IN ('failed', 'expired') THEN $4 ELSE failure_reason END,
          delivered_at = CASE WHEN $2::message_status = 'delivered' THEN $5 ELSE delivered_at END,
          failed_at = CASE WHEN $2::message_status = 'failed' THEN $5 ELSE failed_at END,
          expired_at = CASE WHEN $2::message_status = 'expired' THEN $5 ELSE expired_at END
        WHERE id = $1 AND status = 'sent'
        RETURNING *
      `, [input.messageId, input.status, input.providerStatus.slice(0, 100), input.failureReason?.slice(0, 500) ?? null, input.at]);
      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      const message = mapMessage(row);
      if (input.status !== "sent") {
        await createEventAndDeliveries(client, message, `message.${input.status}`, {
          source: "provider_status",
          provider_status: input.providerStatus.slice(0, 100),
        }, input.at);
      }
      await client.query("COMMIT");
      return message;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getWebhookDelivery(deliveryId: string): Promise<WebhookDeliveryRecord | null> {
    const lockId = randomUUID();
    await this.pool.query(`
      UPDATE webhook_deliveries d SET status = 'dead', last_error = 'Webhook endpoint is disabled.'
      FROM webhooks w
      WHERE d.id = $1 AND w.organization_id = d.organization_id AND w.id = d.webhook_id
        AND w.status <> 'active' AND d.status IN ('pending', 'processing')
    `, [deliveryId]);
    const result = await this.pool.query<DbRow>(`
      WITH claimed AS (
        UPDATE webhook_deliveries d
        SET status = 'processing', attempt_count = d.attempt_count + 1, last_attempt_at = now(),
          locked_at = now(), locked_by = $2
        FROM webhooks active_webhook
        WHERE d.id = $1 AND d.delivered_at IS NULL
          AND (d.status = 'pending' OR (d.status = 'processing' AND d.locked_at < now() - interval '5 minutes'))
          AND active_webhook.organization_id = d.organization_id
          AND active_webhook.id = d.webhook_id AND active_webhook.status = 'active'
        RETURNING d.*
      )
      SELECT c.*, w.url, w.encrypted_secret, e.message_id, e.type AS message_event_type,
        e.payload AS message_event_payload, e.occurred_at AS message_event_occurred_at
      FROM claimed c
      JOIN webhooks w ON w.organization_id = c.organization_id AND w.id = c.webhook_id
      JOIN message_events e ON e.organization_id = c.organization_id AND e.id = c.message_event_id
    `, [deliveryId, lockId]);
    const row = result.rows[0];
    if (!row) return null;
    const event: MessageEventRecord = {
      id: String(row.message_event_id),
      organizationId: String(row.organization_id),
      messageId: String(row.message_id),
      type: String(row.message_event_type),
      payload: jsonObject(row.message_event_payload),
      createdAt: date(row.message_event_occurred_at),
    };
    return {
      id: String(row.id),
      lockId,
      organizationId: String(row.organization_id),
      webhookId: String(row.webhook_id),
      url: String(row.url),
      encryptedSecret: String(row.encrypted_secret),
      payload: jsonObject(row.payload),
      event,
      attemptCount: Number(row.attempt_count),
    };
  }

  async completeWebhookDelivery(input: {
    deliveryId: string;
    lockId: string;
    succeeded: boolean;
    httpStatus?: number;
    error?: string;
    at: Date;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<DbRow>(`
        UPDATE webhook_deliveries SET
          status = CASE
            WHEN $3 THEN 'succeeded'::webhook_delivery_status
            WHEN attempt_count >= max_attempts THEN 'dead'::webhook_delivery_status
            ELSE 'pending'::webhook_delivery_status
          END,
          response_status = $4,
          last_error = $5,
          delivered_at = CASE WHEN $3 THEN $6::timestamptz ELSE NULL END,
          locked_at = NULL,
          locked_by = NULL
        WHERE id = $1 AND locked_by = $2 AND status = 'processing'
        RETURNING organization_id, webhook_id
      `, [input.deliveryId, input.lockId, input.succeeded, input.httpStatus ?? null, input.error?.slice(0, 500) ?? null, input.at]);
      const delivery = result.rows[0];
      if (delivery) {
        const webhook = await client.query<DbRow>(`
          UPDATE webhooks SET
            consecutive_failures = CASE WHEN $3 THEN 0 ELSE consecutive_failures + 1 END,
            last_success_at = CASE WHEN $3 THEN $4::timestamptz ELSE last_success_at END,
            last_failure_at = CASE WHEN $3 THEN last_failure_at ELSE $4::timestamptz END,
            status = CASE
              WHEN NOT $3 AND consecutive_failures + 1 >= 10 THEN 'disabled'::webhook_status
              ELSE status
            END,
            disabled_at = CASE
              WHEN NOT $3 AND consecutive_failures + 1 >= 10 THEN $4::timestamptz
              WHEN $3 THEN NULL
              ELSE disabled_at
            END
          WHERE organization_id = $1 AND id = $2
          RETURNING status
        `, [delivery.organization_id, delivery.webhook_id, input.succeeded, input.at]);
        if (webhook.rows[0]?.status === "disabled") {
          await client.query(`
            UPDATE webhook_deliveries SET
              status = 'dead', locked_at = NULL, locked_by = NULL,
              last_error = 'Webhook endpoint was disabled after 10 consecutive failures.'
            WHERE organization_id = $1 AND webhook_id = $2
              AND status IN ('pending', 'processing')
          `, [delivery.organization_id, delivery.webhook_id]);
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
