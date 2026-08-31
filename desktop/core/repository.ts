import { randomUUID } from "node:crypto";
import type { StatementSync } from "node:sqlite";
import { DesktopDatabase } from "./database.js";
import type {
  ClientRecord,
  CampaignRecord,
  ContactRecord,
  DesktopMessageRecord,
  DesktopMessageStatus,
  MessageEventRecord,
  QueueJobRecord,
} from "./types.js";

type SqlValue = string | number | bigint | null;

function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

function requiredText(value: string, name: string, max: number): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > max) throw new Error(`${name} is invalid`);
  return normalized;
}

export function normalizeDesktopPhone(phone: string): string {
  const normalized = phone.replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{6,14}$/.test(normalized)) throw new Error("Phone must use E.164 format");
  return normalized;
}

function optionalText(value: string | null | undefined, max: number): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  return requiredText(value, "Value", max);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function runTransaction<T>(database: DesktopDatabase, operation: () => T): T {
  database.db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.db.exec("COMMIT");
    return result;
  } catch (error) {
    database.db.exec("ROLLBACK");
    throw error;
  }
}

function clientFromRow(row: Record<string, SqlValue>): ClientRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    email: row.email === null ? null : String(row.email),
    notes: row.notes === null ? null : String(row.notes),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function contactFromRow(row: Record<string, SqlValue>): ContactRecord {
  return {
    id: String(row.id),
    clientId: row.client_id === null ? null : String(row.client_id),
    name: String(row.name),
    phone: String(row.phone),
    consentReference: row.consent_reference === null ? null : String(row.consent_reference),
    tags: parseJson<string[]>(String(row.tags_json), []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function messageFromRow(row: Record<string, SqlValue>): DesktopMessageRecord {
  return {
    id: String(row.id),
    contactId: row.contact_id === null ? null : String(row.contact_id),
    campaignId: row.campaign_id === null ? null : String(row.campaign_id),
    to: String(row.phone),
    content: String(row.content),
    status: String(row.status) as DesktopMessageStatus,
    providerMessageId: row.provider_message_id === null ? null : String(row.provider_message_id),
    failureReason: row.failure_reason === null ? null : String(row.failure_reason),
    scheduledAt: String(row.scheduled_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class DesktopRepository {
  constructor(readonly database: DesktopDatabase) {}

  createClient(input: { name: string; email?: string; notes?: string; now?: Date }): ClientRecord {
    const id = randomUUID();
    const at = nowIso(input.now);
    this.database.db
      .prepare("INSERT INTO clients(id, name, email, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, requiredText(input.name, "Client name", 200), optionalText(input.email, 320), optionalText(input.notes, 4000), at, at);
    return this.getClient(id) as ClientRecord;
  }

  getClient(id: string): ClientRecord | null {
    const row = this.database.db.prepare("SELECT * FROM clients WHERE id = ?").get(id) as Record<string, SqlValue> | undefined;
    return row ? clientFromRow(row) : null;
  }

  listClients(): ClientRecord[] {
    return (this.database.db.prepare("SELECT * FROM clients ORDER BY name, id").all() as Record<string, SqlValue>[]).map(clientFromRow);
  }

  updateClient(id: string, input: { name: string; email?: string; notes?: string; now?: Date }): ClientRecord | null {
    const result = this.database.db
      .prepare("UPDATE clients SET name = ?, email = ?, notes = ?, updated_at = ? WHERE id = ?")
      .run(requiredText(input.name, "Client name", 200), optionalText(input.email, 320), optionalText(input.notes, 4000), nowIso(input.now), id);
    return result.changes === 0 ? null : this.getClient(id);
  }

  deleteClient(id: string): boolean {
    return this.database.db.prepare("DELETE FROM clients WHERE id = ?").run(id).changes > 0;
  }

  createContact(input: {
    clientId?: string;
    name: string;
    phone: string;
    consentReference?: string;
    tags?: string[];
    now?: Date;
  }): ContactRecord {
    const id = randomUUID();
    const at = nowIso(input.now);
    const tags = [...new Set((input.tags ?? []).map((tag) => requiredText(tag, "Tag", 60)))].slice(0, 30);
    this.database.db
      .prepare(
        "INSERT INTO contacts(id, client_id, name, phone, consent_reference, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.clientId ?? null,
        requiredText(input.name, "Contact name", 200),
        normalizeDesktopPhone(input.phone),
        optionalText(input.consentReference, 500),
        JSON.stringify(tags),
        at,
        at,
      );
    return this.getContact(id) as ContactRecord;
  }

  getContact(id: string): ContactRecord | null {
    const row = this.database.db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Record<string, SqlValue> | undefined;
    return row ? contactFromRow(row) : null;
  }

  listContacts(input: { clientId?: string } = {}): ContactRecord[] {
    const statement = input.clientId
      ? this.database.db.prepare("SELECT * FROM contacts WHERE client_id = ? ORDER BY name, id")
      : this.database.db.prepare("SELECT * FROM contacts ORDER BY name, id");
    const rows = (input.clientId ? statement.all(input.clientId) : statement.all()) as Record<string, SqlValue>[];
    return rows.map(contactFromRow);
  }

  deleteContact(id: string): boolean {
    return this.database.db.prepare("DELETE FROM contacts WHERE id = ?").run(id).changes > 0;
  }

  addOptOut(phone: string, reason?: string, now: Date = new Date()): boolean {
    const result = this.database.db
      .prepare("INSERT OR IGNORE INTO opt_outs(phone, reason, created_at) VALUES (?, ?, ?)")
      .run(normalizeDesktopPhone(phone), optionalText(reason, 1000), nowIso(now));
    return result.changes > 0;
  }

  removeOptOut(phone: string): boolean {
    return this.database.db.prepare("DELETE FROM opt_outs WHERE phone = ?").run(normalizeDesktopPhone(phone)).changes > 0;
  }

  isOptedOut(phone: string): boolean {
    return this.database.db.prepare("SELECT 1 FROM opt_outs WHERE phone = ?").get(normalizeDesktopPhone(phone)) !== undefined;
  }

  listOptOuts(): Array<{ phone: string; reason: string | null; createdAt: string }> {
    const rows = this.database.db.prepare("SELECT * FROM opt_outs ORDER BY created_at DESC").all() as Record<string, SqlValue>[];
    return rows.map((row) => ({
      phone: String(row.phone),
      reason: row.reason === null ? null : String(row.reason),
      createdAt: String(row.created_at),
    }));
  }

  setSetting(key: string, value: unknown, now: Date = new Date()): void {
    if (!/^[a-z][a-z0-9._-]{1,79}$/i.test(key)) throw new Error("Invalid setting key");
    if (/(secret|token|password|api.?key)/i.test(key)) throw new Error("Secrets must use SecretStore");
    const serialized = JSON.stringify(value);
    if (serialized === undefined || serialized.length > 64_000) throw new Error("Invalid setting value");
    this.database.db
      .prepare(
        "INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
      )
      .run(key, serialized, nowIso(now));
  }

  getSetting<T>(key: string): T | null {
    const row = this.database.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    return row ? parseJson<T | null>(row.value_json, null) : null;
  }

  createMessage(input: {
    contactId?: string;
    campaignId?: string;
    to: string;
    content: string;
    scheduledAt?: Date;
    now?: Date;
  }): DesktopMessageRecord {
    const phone = normalizeDesktopPhone(input.to);
    if (this.isOptedOut(phone)) throw new Error("Recipient is opted out");
    const id = randomUUID();
    const jobId = randomUUID();
    const at = nowIso(input.now);
    const scheduledAt = nowIso(input.scheduledAt ?? input.now);
    const maxScheduledAt = new Date((input.now ?? new Date()).getTime() + 20 * 24 * 60 * 60 * 1000);
    if ((input.scheduledAt ?? input.now ?? new Date()).getTime() > maxScheduledAt.getTime()) {
      throw new Error("Messages may be scheduled at most 20 days ahead");
    }
    return runTransaction(this.database, () => {
      this.database.db
        .prepare(
          "INSERT INTO messages(id, contact_id, campaign_id, phone, content, status, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
        )
        .run(
          id,
          input.contactId ?? null,
          input.campaignId ?? null,
          phone,
          requiredText(input.content, "Message content", 4000),
          scheduledAt,
          at,
          at,
        );
      this.database.db
        .prepare(
          "INSERT INTO message_events(id, message_id, type, payload_json, created_at) VALUES (?, ?, 'queued', '{}', ?)",
        )
        .run(randomUUID(), id, at);
      this.database.db
        .prepare(
          "INSERT INTO queue_jobs(id, message_id, status, attempts, available_at, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?, ?)",
        )
        .run(jobId, id, scheduledAt, at, at);
      return this.getMessage(id) as DesktopMessageRecord;
    });
  }

  getMessage(id: string): DesktopMessageRecord | null {
    const row = this.database.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Record<string, SqlValue> | undefined;
    return row ? messageFromRow(row) : null;
  }

  listMessages(limit = 100): DesktopMessageRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return (this.database.db.prepare("SELECT * FROM messages ORDER BY created_at DESC LIMIT ?").all(safeLimit) as Record<string, SqlValue>[]).map(
      messageFromRow,
    );
  }

  cancelQueuedMessage(messageId: string, now: Date = new Date()): DesktopMessageRecord | null {
    const existing = this.getMessage(messageId);
    if (!existing || existing.status !== "queued") return null;
    const at = nowIso(now);
    return runTransaction(this.database, () => {
      const job = this.database.db
        .prepare("UPDATE queue_jobs SET status = 'completed', updated_at = ? WHERE message_id = ? AND status = 'pending'")
        .run(at, messageId);
      if (job.changes !== 1) return null;
      const message = this.database.db
        .prepare("UPDATE messages SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'")
        .run(at, messageId);
      if (message.changes !== 1) throw new Error("Queued message changed during cancellation");
      this.addMessageEventStatement().run(randomUUID(), messageId, "cancelled", "{}", at);
      return this.getMessage(messageId);
    });
  }

  getMessageEvents(messageId: string): MessageEventRecord[] {
    const rows = this.database.db
      .prepare("SELECT * FROM message_events WHERE message_id = ? ORDER BY sequence")
      .all(messageId) as Record<string, SqlValue>[];
    return rows.map((row) => ({
      id: String(row.id),
      messageId: String(row.message_id),
      type: String(row.type),
      payload: parseJson<Record<string, unknown>>(String(row.payload_json), {}),
      createdAt: String(row.created_at),
    }));
  }

  claimNextQueueJob(now: Date = new Date()): QueueJobRecord | null {
    return runTransaction(this.database, () => {
      const row = this.database.db
        .prepare("SELECT * FROM queue_jobs WHERE status = 'pending' AND available_at <= ? ORDER BY available_at, created_at LIMIT 1")
        .get(nowIso(now)) as Record<string, SqlValue> | undefined;
      if (!row) return null;
      const at = nowIso(now);
      this.database.db
        .prepare("UPDATE queue_jobs SET status = 'processing', attempts = attempts + 1, locked_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
        .run(at, at, String(row.id));
      this.database.db.prepare("UPDATE messages SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'queued'").run(at, String(row.message_id));
      return {
        id: String(row.id),
        messageId: String(row.message_id),
        status: "processing",
        attempts: Number(row.attempts) + 1,
        availableAt: String(row.available_at),
        lockedAt: at,
        lastError: row.last_error === null ? null : String(row.last_error),
      };
    });
  }

  completeQueueJob(input: {
    jobId: string;
    messageId: string;
    status: Extract<DesktopMessageStatus, "sent" | "delivered" | "failed" | "cancelled">;
    providerMessageId?: string;
    failureReason?: string;
    payload?: Record<string, unknown>;
    now?: Date;
  }): DesktopMessageRecord {
    const at = nowIso(input.now);
    return runTransaction(this.database, () => {
      const jobResult = this.database.db
        .prepare("UPDATE queue_jobs SET status = ?, last_error = ?, locked_at = NULL, updated_at = ? WHERE id = ? AND status = 'processing'")
        .run(input.status === "failed" ? "failed" : "completed", input.failureReason ?? null, at, input.jobId);
      if (jobResult.changes !== 1) throw new Error("Queue job is not processing");
      this.database.db
        .prepare("UPDATE messages SET status = ?, provider_message_id = ?, failure_reason = ?, updated_at = ? WHERE id = ?")
        .run(input.status, input.providerMessageId ?? null, input.failureReason ?? null, at, input.messageId);
      this.addMessageEventStatement().run(randomUUID(), input.messageId, input.status, JSON.stringify(input.payload ?? {}), at);
      const message = this.getMessage(input.messageId);
      if (!message) throw new Error("Message disappeared during dispatch");
      return message;
    });
  }

  recordProviderStatus(input: {
    messageId: string;
    status: "sent" | "delivered" | "failed" | "expired";
    failureReason?: string;
    payload: Record<string, unknown>;
    now?: Date;
  }): DesktopMessageRecord | null {
    return runTransaction(this.database, () => {
      const at = nowIso(input.now);
      const result = this.database.db
        .prepare("UPDATE messages SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ? AND status IN ('sent', 'delivered')")
        .run(input.status, input.failureReason ?? null, at, input.messageId);
      if (result.changes !== 1) return null;
      this.addMessageEventStatement().run(randomUUID(), input.messageId, input.status, JSON.stringify(input.payload), at);
      return this.getMessage(input.messageId);
    });
  }

  queueCampaign(input: {
    name: string;
    content: string;
    recipients: Array<{ contactId?: string; to: string; consentReference: string }>;
    sendAt: Date;
    maxRecipients?: number;
    now?: Date;
  }): { campaign: CampaignRecord; queued: number; skippedOptOut: number } {
    const now = input.now ?? new Date();
    const maxRecipients = Math.max(1, Math.min(5_000, Math.trunc(input.maxRecipients ?? 5_000)));
    if (input.recipients.length < 1 || input.recipients.length > maxRecipients) throw new Error("Campaign recipient limit exceeded");
    if (input.sendAt.getTime() > now.getTime() + 20 * 24 * 60 * 60 * 1000) throw new Error("Campaigns may be scheduled at most 20 days ahead");
    const normalized = input.recipients.map((recipient) => ({
      ...recipient,
      to: normalizeDesktopPhone(recipient.to),
      consentReference: requiredText(recipient.consentReference, "Consent reference", 500),
    }));
    const campaignId = randomUUID();
    const at = nowIso(now);
    const scheduledAt = nowIso(input.sendAt);
    const content = requiredText(input.content, "Campaign content", 4000);
    return runTransaction(this.database, () => {
      this.database.db
        .prepare("INSERT INTO campaigns(id, name, content, scheduled_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'scheduled', ?, ?)")
        .run(campaignId, requiredText(input.name, "Campaign name", 200), content, scheduledAt, at, at);
      let queued = 0;
      let skippedOptOut = 0;
      for (const recipient of normalized) {
        const optedOut = this.isOptedOut(recipient.to);
        const messageId = optedOut ? null : randomUUID();
        if (optedOut || !messageId) {
          this.database.db
            .prepare("INSERT INTO campaign_recipients(id, campaign_id, contact_id, phone, consent_reference, status, message_id, created_at) VALUES (?, ?, ?, ?, ?, 'opted_out', NULL, ?)")
            .run(randomUUID(), campaignId, recipient.contactId ?? null, recipient.to, recipient.consentReference, at);
          skippedOptOut += 1;
          continue;
        }
        this.database.db
          .prepare("INSERT INTO messages(id, contact_id, campaign_id, phone, content, status, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)")
          .run(messageId, recipient.contactId ?? null, campaignId, recipient.to, content, scheduledAt, at, at);
        this.addMessageEventStatement().run(randomUUID(), messageId, "queued", JSON.stringify({ campaignId }), at);
        this.database.db
          .prepare("INSERT INTO queue_jobs(id, message_id, status, attempts, available_at, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?, ?)")
          .run(randomUUID(), messageId, scheduledAt, at, at);
        this.database.db
          .prepare("INSERT INTO campaign_recipients(id, campaign_id, contact_id, phone, consent_reference, status, message_id, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)")
          .run(randomUUID(), campaignId, recipient.contactId ?? null, recipient.to, recipient.consentReference, messageId, at);
        queued += 1;
      }
      const campaign: CampaignRecord = {
        id: campaignId,
        name: requiredText(input.name, "Campaign name", 200),
        content,
        status: "scheduled",
        scheduledAt,
        createdAt: at,
        updatedAt: at,
      };
      return { campaign, queued, skippedOptOut };
    });
  }

  requeueJob(jobId: string, error: string, availableAt: Date, now: Date = new Date()): void {
    const result = this.database.db
      .prepare("UPDATE queue_jobs SET status = 'pending', last_error = ?, locked_at = NULL, available_at = ?, updated_at = ? WHERE id = ? AND status = 'processing'")
      .run(requiredText(error, "Queue error", 2000), nowIso(availableAt), nowIso(now), jobId);
    if (result.changes !== 1) throw new Error("Queue job is not processing");
  }

  private addMessageEventStatement(): StatementSync {
    return this.database.db.prepare(
      "INSERT INTO message_events(id, message_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    );
  }
}
