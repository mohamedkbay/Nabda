import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DesktopDatabase } from "../core/database.js";
import { DesktopRepository, normalizeDesktopPhone } from "../core/repository.js";

const MONTHLY_LIMIT = 5_000;
const MIN_DISPATCH_INTERVAL_MS = 6_000;
const LEASE_MS = 60_000;
const GSM_BASIC = new Set(Array.from("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ`¿abcdefghijklmnopqrstuvwxyzäöñüà"));

type SqlRow = Record<string, string | number | bigint | null>;

function iso(date = new Date()): string { return date.toISOString(); }
function hash(scope: string, value: string): string {
  return createHash("sha256").update(`${scope}:${value}`, "utf8").digest("hex");
}
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
function oneSmsSegment(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return false;
  const gsm = Array.from(normalized).every((character) => GSM_BASIC.has(character));
  return normalized.length <= (gsm ? 160 : 70);
}
function requireText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new ControllerError(422, "validation_error", `${name} is required.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new ControllerError(422, "validation_error", `${name} is invalid.`);
  return normalized;
}

export class ControllerError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfter?: number) {
    super(message);
  }
}

export interface DevicePrincipal { id: string; name: string }

interface PendingPairing {
  tokenHash: string;
  expiresAt: number;
  name: string;
  serverUrl: string;
}

export class LocalController {
  readonly repository: DesktopRepository;
  private pendingPairing: PendingPairing | undefined;

  constructor(readonly database: DesktopDatabase) {
    this.repository = new DesktopRepository(database);
  }

  get liveEnabled(): boolean {
    return this.repository.getSetting<boolean>("controller.live-enabled") === true;
  }

  setLiveEnabled(enabled: boolean, confirmation?: string): void {
    if (enabled && confirmation !== "ENABLE_LIVE_SMS") {
      throw new ControllerError(422, "confirmation_required", "Type ENABLE_LIVE_SMS to enable carrier sending.");
    }
    this.repository.setSetting("controller.live-enabled", enabled);
  }

  getDashboard(lanUrl: string) {
    const messages = this.repository.listMessages(200);
    const contacts = this.repository.listContacts();
    const device = this.database.db.prepare(`
      SELECT id, name, status, last_seen_at, app_version, android_version, created_at
      FROM controller_devices WHERE status = 'active' ORDER BY created_at DESC LIMIT 1
    `).get() as SqlRow | undefined;
    const monthStart = new Date();
    monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const usage = Number((this.database.db.prepare("SELECT COUNT(*) count FROM messages WHERE created_at >= ?").get(monthStart.toISOString()) as SqlRow | undefined)?.count ?? 0);
    return {
      system: { status: "running", lan_url: lanUrl, live_enabled: this.liveEnabled, monthly_limit: MONTHLY_LIMIT, monthly_used: usage, rate_per_minute: 10 },
      device: device ? {
        id: String(device.id), name: String(device.name), status: String(device.status),
        last_seen_at: device.last_seen_at, app_version: device.app_version, android_version: device.android_version,
      } : null,
      counts: {
        contacts: contacts.length,
        queued: messages.filter((message) => ["queued", "processing"].includes(message.status)).length,
        sent: messages.filter((message) => ["sent", "delivered"].includes(message.status)).length,
        failed: messages.filter((message) => ["failed", "expired", "cancelled"].includes(message.status)).length,
      },
      contacts: contacts.map((contact) => ({
        id: contact.id, name: contact.name, phone: contact.phone,
        consent_reference: contact.consentReference, opted_out: this.repository.isOptedOut(contact.phone),
      })),
      messages: messages.map((message) => ({
        id: message.id, to: message.to, content: message.content, status: message.status,
        failure_reason: message.failureReason, scheduled_at: message.scheduledAt,
        created_at: message.createdAt, updated_at: message.updatedAt,
      })),
    };
  }

  createContact(input: Record<string, unknown>) {
    if (input.consent_confirmed !== true) throw new ControllerError(422, "consent_required", "Confirm recipient consent before saving.");
    try {
      return this.repository.createContact({
        name: requireText(input.name, "Contact name", 200),
        phone: requireText(input.phone, "Phone", 32),
        consentReference: requireText(input.consent_reference, "Consent reference", 500),
      });
    } catch (error) {
      throw new ControllerError(422, "validation_error", error instanceof Error ? error.message : "Invalid contact.");
    }
  }

  importContacts(input: Record<string, unknown>): { imported: number; duplicates: number; invalid: number; total: number } {
    if (input.consent_confirmed !== true) throw new ControllerError(422, "consent_required", "Confirm recipient consent before importing.");
    if (!Array.isArray(input.contacts) || input.contacts.length < 1 || input.contacts.length > 500) {
      throw new ControllerError(422, "validation_error", "Import between 1 and 500 contacts per batch.");
    }
    const consentReference = requireText(input.consent_reference, "Consent reference", 500);
    const existingPhones = new Set(this.repository.listContacts().map((contact) => contact.phone));
    const accepted: Array<{ name: string; phone: string }> = [];
    let duplicates = 0;
    let invalid = 0;
    for (const value of input.contacts) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        invalid += 1;
        continue;
      }
      const row = value as Record<string, unknown>;
      try {
        const name = requireText(row.name, "Contact name", 200);
        const phone = normalizeDesktopPhone(requireText(row.phone, "Phone", 32));
        if (existingPhones.has(phone)) {
          duplicates += 1;
          continue;
        }
        existingPhones.add(phone);
        accepted.push({ name, phone });
      } catch {
        invalid += 1;
      }
    }
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      for (const contact of accepted) {
        this.repository.createContact({ ...contact, consentReference });
      }
      this.database.db.exec("COMMIT");
    } catch (error) {
      this.database.db.exec("ROLLBACK");
      throw new ControllerError(422, "import_failed", error instanceof Error ? error.message : "Contact import failed.");
    }
    return { imported: accepted.length, duplicates, invalid, total: input.contacts.length };
  }

  setOptOut(contactId: string, optedOut: boolean): void {
    const contact = this.repository.getContact(contactId);
    if (!contact) throw new ControllerError(404, "not_found", "Contact not found.");
    if (optedOut) {
      this.repository.addOptOut(contact.phone, "Set in the local controller");
      for (const message of this.repository.listMessages(500).filter((item) => item.to === contact.phone && item.status === "queued")) {
        this.repository.cancelQueuedMessage(message.id);
      }
    } else {
      this.repository.removeOptOut(contact.phone);
    }
  }

  createMessage(input: Record<string, unknown>) {
    if (input.consent_confirmed !== true) throw new ControllerError(422, "consent_required", "Confirm recipient consent before queueing.");
    this.assertMonthlyCapacity(1);
    const content = requireText(input.content, "Message", 160);
    if (!oneSmsSegment(content)) throw new ControllerError(422, "single_segment_required", "The phone gateway accepts one SMS segment: 160 GSM characters or 70 Unicode characters.");
    const sendAt = input.send_at ? new Date(requireText(input.send_at, "Schedule", 50)) : undefined;
    if (sendAt && !Number.isFinite(sendAt.getTime())) throw new ControllerError(422, "validation_error", "Schedule is invalid.");
    try {
      return this.repository.createMessage({
        to: requireText(input.to, "Phone", 32), content,
        ...(typeof input.contact_id === "string" && input.contact_id ? { contactId: input.contact_id } : {}),
        ...(sendAt ? { scheduledAt: sendAt } : {}),
      });
    } catch (error) {
      throw new ControllerError(422, "validation_error", error instanceof Error ? error.message : "Invalid message.");
    }
  }

  createCampaign(input: Record<string, unknown>) {
    if (input.consent_confirmed !== true) throw new ControllerError(422, "consent_required", "Confirm recipient consent before queueing.");
    if (!Array.isArray(input.contact_ids)) throw new ControllerError(422, "validation_error", "Select at least one contact.");
    const ids = [...new Set(input.contact_ids.filter((id): id is string => typeof id === "string"))];
    if (ids.length < 1 || ids.length > MONTHLY_LIMIT) throw new ControllerError(422, "validation_error", "Campaign size is invalid.");
    this.assertMonthlyCapacity(ids.length);
    const content = requireText(input.content, "Message", 160);
    if (!oneSmsSegment(content)) throw new ControllerError(422, "single_segment_required", "The phone gateway accepts one SMS segment: 160 GSM characters or 70 Unicode characters.");
    const sendAt = input.send_at ? new Date(requireText(input.send_at, "Schedule", 50)) : new Date();
    if (!Number.isFinite(sendAt.getTime())) throw new ControllerError(422, "validation_error", "Schedule is invalid.");
    const sendUntil = input.send_until ? new Date(requireText(input.send_until, "End schedule", 50)) : undefined;
    if (sendUntil && !Number.isFinite(sendUntil.getTime())) throw new ControllerError(422, "validation_error", "End schedule is invalid.");
    const messagesPerHour = input.messages_per_hour === undefined ? 600 : Number(input.messages_per_hour);
    if (!Number.isInteger(messagesPerHour) || messagesPerHour < 1 || messagesPerHour > 600) {
      throw new ControllerError(422, "validation_error", "Messages per hour must be an integer between 1 and 600.");
    }
    const recipients = ids.map((id) => {
      const contact = this.repository.getContact(id);
      if (!contact) throw new ControllerError(422, "validation_error", "A selected contact no longer exists.");
      if (!contact.consentReference) throw new ControllerError(422, "consent_required", `${contact.name} has no consent reference.`);
      return { contactId: contact.id, to: contact.phone, consentReference: contact.consentReference };
    });
    try {
      return this.repository.queueCampaign({
        name: requireText(input.name, "Campaign name", 200), content, recipients, sendAt,
        ...(sendUntil ? { sendUntil } : {}), messagesPerHour, maxRecipients: MONTHLY_LIMIT,
      });
    } catch (error) {
      throw new ControllerError(422, "validation_error", error instanceof Error ? error.message : "Invalid campaign schedule.");
    }
  }

  cancelMessage(id: string): void {
    if (!this.repository.cancelQueuedMessage(id)) throw new ControllerError(409, "not_cancellable", "Only queued messages can be cancelled.");
    this.database.db.prepare("DELETE FROM device_claims WHERE message_id = ? AND begun_at IS NULL").run(id);
  }

  createPairing(lanUrl: string, nameValue: unknown): {
    pairing_uri: string;
    expires_at: string;
    device_name: string;
  } {
    const serverUrl = requireText(lanUrl, "Server URL", 500).replace(/\/$/, "");
    const name = typeof nameValue === "string" && nameValue.trim()
      ? requireText(nameValue, "Device name", 100)
      : "Company Android";
    const token = `nbda_pair_${randomBytes(32).toString("base64url")}`;
    const expiresAt = Date.now() + 2 * 60_000;
    this.pendingPairing = {
      tokenHash: hash("pairing", token),
      expiresAt,
      name,
      serverUrl,
    };
    const parameters = new URLSearchParams({
      v: "1",
      server: serverUrl,
      token,
    });
    return {
      pairing_uri: `nabda://pair?${parameters.toString()}`,
      expires_at: new Date(expiresAt).toISOString(),
      device_name: name,
    };
  }

  pairDevice(input: Record<string, unknown>): {
    device_id: string;
    device_name: string;
    device_token: string;
    server_url: string;
  } {
    const token = requireText(input.pairing_token, "Pairing token", 256);
    const pending = this.pendingPairing;
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pendingPairing = undefined;
      throw new ControllerError(410, "pairing_expired", "This pairing code expired. Create a new QR code in the controller.");
    }
    if (!safeEqual(pending.tokenHash, hash("pairing", token))) {
      throw new ControllerError(401, "invalid_pairing_token", "The pairing code was rejected.");
    }
    const provisioned = this.provisionDevice(pending.name);
    this.pendingPairing = undefined;
    return {
      device_id: provisioned.id,
      device_name: provisioned.name,
      device_token: provisioned.token,
      server_url: pending.serverUrl,
    };
  }

  provisionDevice(nameValue: unknown): { id: string; name: string; token: string } {
    const name = typeof nameValue === "string" && nameValue.trim() ? requireText(nameValue, "Device name", 100) : "Company Android";
    const id = randomUUID();
    const token = `nbda_device_${randomBytes(32).toString("base64url")}`;
    const at = iso();
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      this.database.db.prepare("UPDATE controller_devices SET status = 'revoked', updated_at = ? WHERE status = 'active'").run(at);
      this.database.db.prepare(`
        INSERT INTO controller_devices(id, name, token_hash, status, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `).run(id, name, hash("device", token), at, at);
      this.database.db.exec("COMMIT");
    } catch (error) {
      this.database.db.exec("ROLLBACK");
      throw error;
    }
    return { id, name, token };
  }

  authenticateDevice(token: string): DevicePrincipal {
    const candidate = hash("device", token);
    const rows = this.database.db.prepare("SELECT id, name, token_hash FROM controller_devices WHERE status = 'active'").all() as SqlRow[];
    const device = rows.find((row) => safeEqual(String(row.token_hash), candidate));
    if (!device) throw new ControllerError(401, "invalid_device_token", "The device token was rejected.");
    return { id: String(device.id), name: String(device.name) };
  }

  heartbeat(device: DevicePrincipal, input: Record<string, unknown>) {
    this.assertExecutionMode(input);
    const at = iso();
    this.database.db.prepare(`
      UPDATE controller_devices SET last_seen_at = ?, app_version = ?, android_version = ?, updated_at = ? WHERE id = ?
    `).run(at, String(input.app_version ?? "").slice(0, 100), String(input.android_version ?? "").slice(0, 100), at, device.id);
    return { server_time: at, device_id: device.id, poll_after_ms: 2_000, live_reporting_enabled: this.liveEnabled };
  }

  claim(device: DevicePrincipal, input: Record<string, unknown>) {
    const simulated = this.assertExecutionMode(input);
    if (!simulated && !this.liveEnabled) throw new ControllerError(503, "live_sending_disabled", "Enable phone sending in the Windows dashboard first.");
    this.reconcileExpiredClaims();
    const now = new Date();
    const row = this.database.db.prepare(`
      SELECT m.id, m.phone, m.content
      FROM queue_jobs q
      JOIN messages m ON m.id = q.message_id
      LEFT JOIN device_claims c ON c.message_id = m.id
      LEFT JOIN opt_outs o ON o.phone = m.phone
      WHERE q.status = 'pending' AND q.available_at <= ? AND m.status = 'queued'
        AND c.message_id IS NULL AND o.phone IS NULL
      ORDER BY q.available_at, q.created_at LIMIT 1
    `).get(now.toISOString()) as SqlRow | undefined;
    if (!row) return { messages: [], poll_after_ms: 2_000 };
    const rawLease = randomBytes(32).toString("base64url");
    const expires = new Date(now.getTime() + LEASE_MS);
    try {
      this.database.db.prepare(`
        INSERT INTO device_claims(message_id, device_id, lease_hash, lease_expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(String(row.id), device.id, hash("lease", rawLease), expires.toISOString(), now.toISOString(), now.toISOString());
    } catch {
      return { messages: [], poll_after_ms: 500 };
    }
    return { messages: [{
      id: String(row.id), to: String(row.phone), body: String(row.content),
      execution_mode: simulated ? "simulation" : "live",
      lease_token: rawLease, lease_expires_at: expires.toISOString(),
    }], poll_after_ms: 250 };
  }

  begin(device: DevicePrincipal, messageId: string, input: Record<string, unknown>) {
    const simulated = this.assertExecutionMode(input);
    if (!simulated && !this.liveEnabled) throw new ControllerError(503, "live_sending_disabled", "Phone sending was disabled before authorization.");
    const lease = requireText(input.lease_token, "Lease token", 256);
    const attemptId = requireText(input.attempt_id, "Attempt ID", 100);
    const row = this.database.db.prepare(`
      SELECT c.*, m.phone, m.status message_status, q.status queue_status
      FROM device_claims c JOIN messages m ON m.id = c.message_id JOIN queue_jobs q ON q.message_id = m.id
      WHERE c.message_id = ? AND c.device_id = ?
    `).get(messageId, device.id) as SqlRow | undefined;
    this.assertLease(row, lease);
    if (row?.attempt_id) {
      if (String(row.attempt_id) !== attemptId) throw new ControllerError(409, "attempt_conflict", "This lease is already bound to another attempt.");
      return { authorized: true, duplicate: true, attempt_id: attemptId };
    }
    if (this.repository.isOptedOut(String(row?.phone))) {
      this.repository.cancelQueuedMessage(messageId);
      throw new ControllerError(409, "recipient_opted_out", "The recipient opted out before dispatch.");
    }
    if (String(row?.message_status) !== "queued" || String(row?.queue_status) !== "pending") throw new ControllerError(409, "message_not_queued", "The message is no longer queued.");
    const previous = this.repository.getSetting<string>("controller.last-dispatch-at");
    const elapsed = previous ? Date.now() - new Date(previous).getTime() : Number.POSITIVE_INFINITY;
    if (elapsed < MIN_DISPATCH_INTERVAL_MS) throw new ControllerError(429, "rate_limited", "Wait before dispatching the next message.", Math.ceil((MIN_DISPATCH_INTERVAL_MS - elapsed) / 1_000));
    const at = iso();
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      this.database.db.prepare("UPDATE device_claims SET attempt_id = ?, begun_at = ?, updated_at = ? WHERE message_id = ? AND attempt_id IS NULL").run(attemptId, at, at, messageId);
      this.database.db.prepare("UPDATE queue_jobs SET status = 'processing', attempts = attempts + 1, locked_at = ?, updated_at = ? WHERE message_id = ? AND status = 'pending'").run(at, at, messageId);
      this.database.db.prepare("UPDATE messages SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'queued'").run(at, messageId);
      this.database.db.exec("COMMIT");
    } catch (error) {
      this.database.db.exec("ROLLBACK");
      throw error;
    }
    this.repository.setSetting("controller.last-dispatch-at", at);
    return { authorized: true, duplicate: false, attempt_id: attemptId };
  }

  event(device: DevicePrincipal, messageId: string, input: Record<string, unknown>) {
    const simulated = this.assertExecutionMode(input);
    const lease = requireText(input.lease_token, "Lease token", 256);
    const attemptId = requireText(input.attempt_id, "Attempt ID", 100);
    const eventId = requireText(input.event_id, "Event ID", 100);
    const eventHash = hash("event", JSON.stringify(input));
    const existing = this.database.db.prepare("SELECT event_hash, response_json FROM device_event_receipts WHERE event_id = ?").get(eventId) as SqlRow | undefined;
    if (existing) {
      if (!safeEqual(String(existing.event_hash), eventHash)) throw new ControllerError(409, "device_event_conflict", "The event ID was already used with different data.");
      return { ...JSON.parse(String(existing.response_json)) as Record<string, unknown>, duplicate: true };
    }
    const row = this.database.db.prepare(`
      SELECT c.*, q.id job_id, q.status queue_status, m.status message_status
      FROM device_claims c JOIN queue_jobs q ON q.message_id = c.message_id JOIN messages m ON m.id = c.message_id
      WHERE c.message_id = ? AND c.device_id = ?
    `).get(messageId, device.id) as SqlRow | undefined;
    this.assertLease(row, lease, true);
    if (!row?.begun_at || String(row.attempt_id) !== attemptId) throw new ControllerError(409, "attempt_mismatch", "The dispatch attempt is not authorized.");
    if (String(row.queue_status) !== "processing" || String(row.message_status) !== "processing") throw new ControllerError(409, "message_not_processing", "The message is no longer processing.");
    const reported = String(input.status ?? "");
    if (!['sent', 'delivered', 'failed'].includes(reported)) throw new ControllerError(422, "validation_error", "Unsupported device event status.");
    const status = simulated ? "cancelled" : reported as "sent" | "delivered" | "failed";
    const failureReason = simulated ? "Simulation only — no SMS sent" : reported === "failed" ? String(input.error_message ?? input.error_code ?? "Android dispatch failed").slice(0, 500) : undefined;
    const result = this.repository.completeQueueJob({
      jobId: String(row.job_id), messageId, status,
      ...(typeof input.provider_message_id === "string" ? { providerMessageId: input.provider_message_id.slice(0, 200) } : {}),
      ...(failureReason ? { failureReason } : {}),
      payload: { source: "android_lan", event_id: eventId, simulated },
    });
    const response = { accepted: true, duplicate: false, status: result.status, ...(simulated ? { failure_code: "simulation_only" } : {}) };
    this.database.db.prepare(`
      INSERT INTO device_event_receipts(event_id, message_id, event_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(eventId, messageId, eventHash, JSON.stringify(response), iso());
    return response;
  }

  private assertExecutionMode(input: Record<string, unknown>): boolean {
    if (typeof input.simulated !== "boolean") throw new ControllerError(422, "validation_error", "The device execution mode is required.");
    return input.simulated;
  }

  private assertMonthlyCapacity(incoming: number): void {
    const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    const used = Number((this.database.db.prepare("SELECT COUNT(*) count FROM messages WHERE created_at >= ?").get(start.toISOString()) as SqlRow | undefined)?.count ?? 0);
    if (used + incoming > MONTHLY_LIMIT) throw new ControllerError(429, "monthly_limit_reached", "The 5,000-message monthly limit would be exceeded.");
  }

  private assertLease(row: SqlRow | undefined, rawLease: string, allowExpiredAfterBegin = false): void {
    if (!row || !safeEqual(String(row.lease_hash), hash("lease", rawLease))) throw new ControllerError(409, "invalid_lease", "The message lease is invalid.");
    if (new Date(String(row.lease_expires_at)).getTime() < Date.now() && !(allowExpiredAfterBegin && row.begun_at)) {
      throw new ControllerError(410, "lease_expired", "The message lease expired.");
    }
  }

  private reconcileExpiredClaims(): void {
    const now = iso();
    const uncertain = this.database.db.prepare(`
      SELECT c.message_id, q.id job_id FROM device_claims c JOIN queue_jobs q ON q.message_id = c.message_id
      WHERE c.lease_expires_at < ? AND c.begun_at IS NOT NULL AND q.status = 'processing'
    `).all(now) as SqlRow[];
    for (const row of uncertain) {
      this.repository.completeQueueJob({
        jobId: String(row.job_id), messageId: String(row.message_id), status: "failed",
        failureReason: "MANUAL_REVIEW_REQUIRED: phone did not report the authorized carrier outcome.",
        payload: { manual_review: true, source: "android_lan" },
      });
    }
    this.database.db.prepare("DELETE FROM device_claims WHERE lease_expires_at < ?").run(now);
  }
}
