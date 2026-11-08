import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().unique(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
});

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at"),
}, (t) => [index("api_keys_organization").on(t.organizationId)]);

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  status: text("status").notNull().default("active"),
  ready: integer("ready").notNull().default(0),
  permissionGranted: integer("permission_granted").notNull().default(0),
  simSelected: integer("sim_selected").notNull().default(0),
  appVersion: text("app_version"),
  androidVersion: text("android_version"),
  lastSeenAt: text("last_seen_at"),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at"),
}, (t) => [index("devices_organization").on(t.organizationId)]);

export const pairings = sqliteTable("pairings", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
  consumedDeviceId: text("consumed_device_id"),
  createdAt: text("created_at").notNull(),
}, (t) => [index("pairings_organization").on(t.organizationId)]);

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  deviceId: text("device_id").notNull().references(() => devices.id),
  idempotencyHash: text("idempotency_hash").notNull(),
  payloadHash: text("payload_hash").notNull(),
  status: text("status").notNull(),
  sandbox: integer("sandbox").notNull().default(0),
  cancellationRequested: integer("cancellation_requested").notNull().default(0),
  sendAt: text("send_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  handedOffAt: text("handed_off_at"),
  partsTotal: integer("parts_total"),
  partsSent: integer("parts_sent"),
  partsDelivered: integer("parts_delivered"),
  failureCode: text("failure_code"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("messages_org_idempotency").on(t.organizationId, t.idempotencyHash),
  index("messages_org_created").on(t.organizationId, t.createdAt),
  index("messages_device").on(t.deviceId, t.status),
]);

export const commands = sqliteTable("commands", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  deviceId: text("device_id").notNull().references(() => devices.id),
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  payloadJson: text("payload_json"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  acknowledgedAt: text("acknowledged_at"),
}, (t) => [index("commands_device_pending").on(t.deviceId, t.acknowledgedAt, t.createdAt)]);

export const messageEvents = sqliteTable("message_events", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  deviceId: text("device_id").notNull().references(() => devices.id),
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  payloadHash: text("payload_hash").notNull(),
  occurredAt: text("occurred_at").notNull(),
  receivedAt: text("received_at").notNull(),
}, (t) => [uniqueIndex("events_device_event").on(t.deviceId, t.eventId)]);

export const optOuts = sqliteTable("opt_outs", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  phoneHash: text("phone_hash").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [uniqueIndex("opt_outs_org_phone").on(t.organizationId, t.phoneHash)]);

// Independent hosting identities are separate from legacy Sites owner IDs.
// Account ownership uses github:<stable numeric ID>, never an email address.
export const independentUsers = sqliteTable("independent_users", {
  id: text("id").primaryKey(),
  githubId: text("github_id").notNull().unique(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const browserSessions = sqliteTable("browser_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => independentUsers.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (t) => [index("browser_sessions_user").on(t.userId), index("browser_sessions_expiry").on(t.expiresAt)]);

export const oauthAttempts = sqliteTable("oauth_attempts", {
  stateHash: text("state_hash").primaryKey(),
  browserHash: text("browser_hash").notNull().unique(),
  verifier: text("verifier").notNull(),
  returnTo: text("return_to").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (t) => [index("oauth_attempts_expiry").on(t.expiresAt)]);
