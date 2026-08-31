export interface DesktopMigration {
  version: number;
  name: string;
  sql: string;
}

export const DESKTOP_SCHEMA_VERSION = 3;

export const desktopMigrations: readonly DesktopMigration[] = [
  {
    version: 1,
    name: "initial_local_schema",
    sql: `
      CREATE TABLE clients (id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200), email TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE contacts (id TEXT PRIMARY KEY, client_id TEXT REFERENCES clients(id) ON DELETE SET NULL, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200), phone TEXT NOT NULL UNIQUE, consent_reference TEXT, tags_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX contacts_client_idx ON contacts(client_id);
      CREATE TABLE opt_outs (phone TEXT PRIMARY KEY, reason TEXT, created_at TEXT NOT NULL);
      CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, installation_id TEXT UNIQUE, platform TEXT, app_version TEXT, status TEXT NOT NULL CHECK(status IN ('pending', 'connected', 'offline', 'revoked')), last_seen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE device_credentials (device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, revoked_at TEXT, last_seen_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE pairing_sessions (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, device_id TEXT REFERENCES devices(id) ON DELETE SET NULL, phone TEXT NOT NULL, content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 4000), status TEXT NOT NULL CHECK(status IN ('queued', 'processing', 'sent', 'delivered', 'failed', 'expired', 'cancelled')), provider_message_id TEXT, failure_reason TEXT, scheduled_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX messages_status_schedule_idx ON messages(status, scheduled_at);
      CREATE TABLE message_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
      CREATE INDEX message_events_message_idx ON message_events(message_id, sequence);
      CREATE TABLE queue_jobs (id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'failed')), attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0), available_at TEXT NOT NULL, locked_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX queue_jobs_claim_idx ON queue_jobs(status, available_at);
    `,
  },
  {
    version: 2,
    name: "httpsms_campaigns",
    sql: `
      CREATE TABLE campaigns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft', 'scheduled', 'running', 'completed', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      ALTER TABLE messages ADD COLUMN campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL;
      CREATE INDEX messages_campaign_idx ON messages(campaign_id, created_at);
      CREATE TABLE campaign_recipients (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        phone TEXT NOT NULL,
        consent_reference TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued', 'opted_out', 'cancelled')),
        message_id TEXT UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX campaign_recipients_campaign_idx ON campaign_recipients(campaign_id, status);
    `,
  },
  {
    version: 3,
    name: "remove_legacy_local_pairing",
    sql: `
      DROP TABLE pairing_sessions;
      DROP TABLE device_credentials;
      ALTER TABLE messages DROP COLUMN device_id;
      DROP TABLE devices;
    `,
  },
];
