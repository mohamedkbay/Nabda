/**
 * Nabda control plane. Android owns the SMS queue and message database.
 * D1 temporarily stores commands until the phone commits and acknowledges them.
 * Browser identity is supplied explicitly by a verified authentication adapter.
 */
type SqlRow = Record<string, string | number | null>;
type Principal = { organizationId: string; deviceId?: string };
export type BrowserUser = { id: string; email: string; name: string };
type ApiEnv = { DB?: D1Database };

const VERSION = "0.2.0";
const MAX_BODY_BYTES = 131_072;
const MAX_PENDING_COMMANDS = 500;
const MAX_NEW_MESSAGES_PER_DAY = 1_000;
const POLL_AFTER_MS = 60_000;
const encoder = new TextEncoder();
const EVENT_STATUSES = new Set(["queued", "processing", "sent", "delivered", "failed", "cancelled", "expired", "outcome_unknown"]);

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function secret(prefix: string): string {
  const random = crypto.getRandomValues(new Uint8Array(32));
  return prefix + Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("");
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ApiError(422, "validation_error", `${field} must contain between 1 and ${max} characters.`);
  }
  return value.trim();
}

function shortOptional(value: unknown, max = 80): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max) throw new ApiError(422, "validation_error", "A text field is invalid.");
  return value;
}

export function normalizePhone(input: unknown): string {
  let value = text(input, "to", 40)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[\s()\-]/g, "");
  if (value.startsWith("00")) value = "+" + value.slice(2);
  if (/^09[1-6]\d{7}$/.test(value)) value = "+218" + value.slice(1);
  else if (/^9[1-6]\d{7}$/.test(value)) value = "+218" + value;
  else if (/^2189[1-6]\d{7}$/.test(value)) value = "+" + value;
  if (!/^\+[1-9]\d{7,14}$/.test(value)) throw new ApiError(422, "invalid_phone", "Use an international phone number or a Libyan mobile number.");
  return value;
}

function dateField(value: unknown, field: string): string {
  if (typeof value !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new ApiError(422, "invalid_time", `${field} must include a timezone, for example 2026-11-08T12:00:00Z.`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new ApiError(422, "invalid_time", `${field} is invalid.`);
  return new Date(ms).toISOString();
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "json_required", "Send a JSON request with Content-Type: application/json.");
  }
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) throw new ApiError(413, "request_too_large", "The request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "invalid_json", "A JSON object is required.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError(413, "request_too_large", "The request is too large.");
      }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("object required");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_json", "The body must be a valid JSON object.");
  }
}

function json(data: unknown, status = 200, publicApi = false): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (publicApi) {
    headers["Access-Control-Allow-Origin"] = "*";
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, Idempotency-Key";
    headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function identity(user: BrowserUser | undefined): BrowserUser {
  if (!user?.id || !user.email) throw new ApiError(401, "sign_in_required", "Sign in to manage your Nabda account.");
  return user;
}

function checkBrowserMutation(request: Request): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError(403, "origin_rejected", "Open Nabda in its own browser tab and try again.");
  }
}

async function organization(db: D1Database, user: BrowserUser): Promise<SqlRow> {
  const existing = await db.prepare("SELECT id,name,created_at FROM organizations WHERE owner_id=?").bind(user.id).first<SqlRow>();
  if (existing) return existing;
  await db.prepare("INSERT OR IGNORE INTO organizations(id,owner_id,name,created_at) VALUES(?,?,?,?)")
    .bind(crypto.randomUUID(), user.id, `${user.name}'s workspace`, new Date().toISOString()).run();
  return (await db.prepare("SELECT id,name,created_at FROM organizations WHERE owner_id=?").bind(user.id).first<SqlRow>())!;
}

async function bearer(request: Request, db: D1Database, kind: "app" | "device"): Promise<Principal> {
  const raw = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_]+)$/)?.[1];
  const expected = kind === "app" ? "nb_app_" : "nb_device_";
  if (!raw?.startsWith(expected) || raw.length !== expected.length + 64) throw new ApiError(401, "invalid_token", `A valid ${kind === "app" ? "application API key" : "device token"} is required.`);
  const hash = await digest(raw);
  const row = kind === "app"
    ? await db.prepare("SELECT organization_id FROM api_keys WHERE token_hash=? AND revoked_at IS NULL").bind(hash).first<SqlRow>()
    : await db.prepare("SELECT organization_id,id FROM devices WHERE token_hash=? AND status='active'").bind(hash).first<SqlRow>();
  if (!row) throw new ApiError(401, "invalid_token", "This credential is invalid or has been revoked.");
  return { organizationId: String(row.organization_id), ...(kind === "device" ? { deviceId: String(row.id) } : {}) };
}

function deviceView(row: SqlRow) {
  return {
    id: row.id, name: row.name, status: row.status, ready: Boolean(row.ready),
    permission_granted: Boolean(row.permission_granted), sim_selected: Boolean(row.sim_selected),
    app_version: row.app_version, android_version: row.android_version,
    last_seen_at: row.last_seen_at, created_at: row.created_at,
    connected: row.status === "active" && !!row.last_seen_at && Date.now() - Date.parse(String(row.last_seen_at)) < 180_000,
  };
}

function messageView(row: SqlRow) {
  return {
    id: row.id, status: row.status, device_id: row.device_id, sandbox: Boolean(row.sandbox),
    created_at: row.created_at, updated_at: row.updated_at, send_at: row.send_at, expires_at: row.expires_at,
    handed_off_at: row.handed_off_at, cancellation_requested: Boolean(row.cancellation_requested),
    parts_total: row.parts_total, parts_sent: row.parts_sent, parts_delivered: row.parts_delivered,
    failure_code: row.failure_code,
  };
}

async function usage(db: D1Database, organizationId: string) {
  const day = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
  const [today, pending, devicesCount] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS accepted_commands, COALESCE(SUM(CASE WHEN status='sent' OR status='delivered' THEN 1 ELSE 0 END),0) AS reported_sent_messages, COALESCE(SUM(CASE WHEN status='sent' OR status='delivered' THEN parts_sent ELSE 0 END),0) AS reported_sent_parts FROM messages WHERE organization_id=? AND created_at>=?").bind(organizationId, day).first<SqlRow>(),
    db.prepare("SELECT COUNT(*) AS total FROM commands WHERE organization_id=? AND acknowledged_at IS NULL AND expires_at>?").bind(organizationId, new Date().toISOString()).first<SqlRow>(),
    db.prepare("SELECT COUNT(*) AS total FROM devices WHERE organization_id=? AND status='active'").bind(organizationId).first<SqlRow>(),
  ]);
  return {
    day_utc: day.slice(0, 10), accepted_commands: Number(today?.accepted_commands ?? 0),
    reported_sent_messages: Number(today?.reported_sent_messages ?? 0), reported_sent_parts: Number(today?.reported_sent_parts ?? 0),
    pending_handoffs: Number(pending?.total ?? 0), active_devices: Number(devicesCount?.total ?? 0),
    carrier_cost: null, source: "device_reported", limits: { new_messages_per_day: MAX_NEW_MESSAGES_PER_DAY, pending_handoffs: MAX_PENDING_COMMANDS },
  };
}

async function messageById(db: D1Database, organizationId: string, id: string): Promise<SqlRow> {
  const row = await db.prepare("SELECT * FROM messages WHERE organization_id=? AND id=?").bind(organizationId, id).first<SqlRow>();
  if (!row) throw new ApiError(404, "not_found", "The message was not found.");
  return row;
}

async function listMessages(db: D1Database, org: string, url: URL) {
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 30));
  const cursor = url.searchParams.get("cursor");
  let cursorTime: string | null = null;
  let cursorId: string | null = null;
  if (cursor) {
    try {
      const parsed: unknown = JSON.parse(atob(cursor));
      if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((v) => typeof v !== "string")) throw new Error();
      [cursorTime, cursorId] = parsed;
      if (String(cursorTime).length > 30 || String(cursorId).length > 80) throw new Error();
    } catch { throw new ApiError(422, "invalid_cursor", "The page cursor is invalid."); }
  }
  const rows = await db.prepare(`SELECT * FROM messages WHERE organization_id=? ${cursor ? "AND (created_at < ? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`)
    .bind(...(cursor ? [org, cursorTime, cursorTime, cursorId, limit + 1] : [org, limit + 1])).all<SqlRow>();
  const page = rows.results.slice(0, limit);
  const groups = await db.prepare("SELECT status,COUNT(*) AS count FROM messages WHERE organization_id=? GROUP BY status").bind(org).all<SqlRow>();
  const counts = Object.fromEntries(groups.results.map((row) => [String(row.status), Number(row.count)]));
  const tail = page.at(-1);
  return { messages: page.map(messageView), counts, as_of: new Date().toISOString(), next_cursor: rows.results.length > limit && tail ? btoa(JSON.stringify([tail.created_at, tail.id])) : null };
}

async function expireCommands(db: D1Database, principal: Principal): Promise<void> {
  const at = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE messages SET status='expired',updated_at=? WHERE device_id=? AND organization_id=? AND status='accepted' AND expires_at<=?").bind(at, principal.deviceId!, principal.organizationId, at),
    db.prepare("UPDATE commands SET payload_json=NULL,acknowledged_at=? WHERE device_id=? AND organization_id=? AND acknowledged_at IS NULL AND expires_at<=?").bind(at, principal.deviceId!, principal.organizationId, at),
  ]);
}

async function management(request: Request, db: D1Database, url: URL, browserUser?: BrowserUser): Promise<Response> {
  const user = identity(browserUser);
  checkBrowserMutation(request);
  const org = await organization(db, user);
  const orgId = String(org.id);
  const path = url.pathname.replace(/\/$/, "");
  const method = request.method;
  if (method === "GET" && path === "/api/account") {
    const [phoneRows, keyRows, counts] = await Promise.all([
      db.prepare("SELECT * FROM devices WHERE organization_id=? ORDER BY created_at DESC LIMIT 100").bind(orgId).all<SqlRow>(),
      db.prepare("SELECT id,name,prefix,created_at,revoked_at FROM api_keys WHERE organization_id=? ORDER BY created_at DESC LIMIT 100").bind(orgId).all<SqlRow>(),
      usage(db, orgId),
    ]);
    return json({ organization: org, user: { name: user.name, email: user.email }, devices: phoneRows.results.map(deviceView), keys: keyRows.results, usage: counts, version: VERSION });
  }
  if (method === "GET" && path === "/api/devices") {
    const rows = await db.prepare("SELECT * FROM devices WHERE organization_id=? ORDER BY created_at DESC LIMIT 100").bind(orgId).all<SqlRow>();
    return json({ devices: rows.results.map(deviceView) });
  }
  if (method === "POST" && path === "/api/keys") {
    const input = await body(request);
    const name = text(input.name, "name", 80);
    const id = crypto.randomUUID();
    const key = secret("nb_app_");
    const at = new Date().toISOString();
    const result = await db.prepare("INSERT INTO api_keys(id,organization_id,name,prefix,token_hash,created_at) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM api_keys WHERE organization_id=? AND revoked_at IS NULL)<20")
      .bind(id, orgId, name, key.slice(0, 15), await digest(key), at, orgId).run();
    if (!result.meta.changes) throw new ApiError(429, "key_limit", "Revoke an unused key before creating another. Each workspace can have 20 active keys.");
    return json({ id, name, key, created_at: at }, 201);
  }
  const keyDelete = path.match(/^\/api\/keys\/([^/]+)$/);
  if (method === "DELETE" && keyDelete) {
    const result = await db.prepare("UPDATE api_keys SET revoked_at=? WHERE organization_id=? AND id=? AND revoked_at IS NULL").bind(new Date().toISOString(), orgId, keyDelete[1]).run();
    if (!result.meta.changes) throw new ApiError(404, "not_found", "The active API key was not found.");
    return json({ revoked: true });
  }
  if (method === "POST" && path === "/api/pairings") {
    const input = await body(request);
    const name = input.name ? text(input.name, "name", 80) : "My Android phone";
    const token = secret("nb_pair_");
    const at = new Date();
    const expires = new Date(at.getTime() + 10 * 60_000).toISOString();
    const results = await db.batch([
      db.prepare("DELETE FROM pairings WHERE organization_id=? AND (expires_at<? OR consumed_at IS NOT NULL)").bind(orgId, at.toISOString()),
      db.prepare("INSERT INTO pairings(id,organization_id,name,token_hash,expires_at,created_at) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM pairings WHERE organization_id=? AND consumed_at IS NULL AND expires_at>?)<5").bind(crypto.randomUUID(), orgId, name, await digest(token), expires, at.toISOString(), orgId, at.toISOString()),
    ]);
    if (!results[1].meta.changes) throw new ApiError(429, "pairing_limit", "There are already five active pairing codes. Wait for them to expire.");
    return json({ pairing_token: token, expires_at: expires, qr: { version: 1, server_url: url.origin, pairing_token: token }, pairing_url: `nabda://pair?server=${encodeURIComponent(url.origin)}&token=${encodeURIComponent(token)}` }, 201);
  }
  const deviceDelete = path.match(/^\/api\/devices\/([^/]+)$/);
  if (method === "DELETE" && deviceDelete) {
    const device = await db.prepare("SELECT id FROM devices WHERE organization_id=? AND id=?").bind(orgId, deviceDelete[1]).first<SqlRow>();
    if (!device) throw new ApiError(404, "not_found", "The phone was not found.");
    const at = new Date().toISOString();
    await db.batch([
      db.prepare("UPDATE devices SET status='revoked',ready=0,revoked_at=? WHERE organization_id=? AND id=?").bind(at, orgId, deviceDelete[1]),
      db.prepare("UPDATE messages SET status='cancelled',cancellation_requested=1,updated_at=? WHERE organization_id=? AND device_id=? AND status='accepted'").bind(at, orgId, deviceDelete[1]),
      db.prepare("UPDATE commands SET payload_json=NULL,acknowledged_at=? WHERE organization_id=? AND device_id=? AND acknowledged_at IS NULL").bind(at, orgId, deviceDelete[1]),
    ]);
    return json({ revoked: true, note: "The phone cannot receive new work. Already handed-off work must be stopped on the phone itself." });
  }
  if (method === "GET" && path === "/api/messages") return json(await listMessages(db, orgId, url));
  const cancellation = path.match(/^\/api\/messages\/([^/]+)\/cancel$/);
  if (method === "POST" && cancellation) return json(await cancelMessage(db, orgId, cancellation[1]));
  throw new ApiError(404, "not_found", "This endpoint was not found.");
}

async function cancelMessage(db: D1Database, orgId: string, id: string) {
  const current = await messageById(db, orgId, id);
  if (["sent", "delivered", "failed", "expired"].includes(String(current.status))) throw new ApiError(409, "cannot_cancel", "This message has already finished. A sent SMS cannot be recalled.");
  if (current.status === "cancelled") return { id, status: "cancelled", cancellation_requested: true, guaranteed: true };
  const at = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE messages SET status='cancelled',cancellation_requested=1,updated_at=? WHERE id=? AND organization_id=? AND status='accepted' AND handed_off_at IS NULL").bind(at, id, orgId),
    db.prepare("UPDATE commands SET acknowledged_at=?,payload_json=NULL WHERE message_id=? AND organization_id=? AND type='message.send' AND acknowledged_at IS NULL AND EXISTS(SELECT 1 FROM messages WHERE id=? AND organization_id=? AND status='cancelled')").bind(at, id, orgId, id, orgId),
    db.prepare("INSERT OR IGNORE INTO commands(id,organization_id,device_id,message_id,type,payload_json,expires_at,created_at) SELECT ?,organization_id,device_id,id,'message.cancel','{}',expires_at,? FROM messages WHERE id=? AND organization_id=? AND handed_off_at IS NOT NULL AND status NOT IN('sent','delivered','failed','cancelled','expired')").bind(`cancel_${id}`, at, id, orgId),
    db.prepare("UPDATE messages SET cancellation_requested=1,updated_at=? WHERE id=? AND organization_id=? AND status NOT IN('sent','delivered','failed','expired')").bind(at, id, orgId),
  ]);
  const after = await messageById(db, orgId, id);
  return { id, status: after.status, cancellation_requested: true, guaranteed: after.status === "cancelled", note: after.status === "cancelled" ? "Cancelled before handoff." : "The phone will confirm whether it can still cancel this message." };
}

async function sendMessage(request: Request, db: D1Database, principal: Principal): Promise<Response> {
  const key = request.headers.get("idempotency-key");
  if (!key || !/^[\x21-\x7e]{8,128}$/.test(key)) throw new ApiError(422, "idempotency_key_required", "Set Idempotency-Key to a unique value of 8–128 printable characters.");
  const input = await body(request);
  const deviceId = text(input.device_id, "device_id", 80);
  const to = normalizePhone(input.to);
  if (typeof input.content !== "string" || !input.content.trim() || input.content.length > 4_000) throw new ApiError(422, "invalid_content", "content must contain between 1 and 4,000 characters.");
  if (input.sandbox !== undefined && typeof input.sandbox !== "boolean") throw new ApiError(422, "validation_error", "sandbox must be true or false.");
  const content = input.content;
  const sandbox = input.sandbox === true;
  const requestedSend = input.send_at === undefined ? null : dateField(input.send_at, "send_at");
  const requestedExpiry = input.expires_at === undefined ? null : dateField(input.expires_at, "expires_at");
  const payloadHash = await digest(JSON.stringify({ device_id: deviceId, to, content, sandbox, send_at: requestedSend, expires_at: requestedExpiry }));
  const idempotencyHash = await digest(`messages:create:${key}`);
  const existing = await db.prepare("SELECT * FROM messages WHERE organization_id=? AND idempotency_hash=?").bind(principal.organizationId, idempotencyHash).first<SqlRow>();
  if (existing) {
    if (existing.payload_hash !== payloadHash) throw new ApiError(409, "idempotency_conflict", "This Idempotency-Key was already used with a different request.");
    return json(messageView(existing), 202, true);
  }
  const now = new Date();
  const at = now.toISOString();
  const sendAt = requestedSend ?? at;
  const expires = requestedExpiry ?? new Date(Math.max(Date.parse(sendAt), now.getTime()) + 86_400_000).toISOString();
  if (Date.parse(sendAt) > now.getTime() + 30 * 86_400_000 || Date.parse(expires) > now.getTime() + 31 * 86_400_000) throw new ApiError(422, "schedule_too_far", "Schedule within 30 days and set expiry within 31 days.");
  if (Date.parse(expires) <= now.getTime() || expires <= sendAt) throw new ApiError(422, "invalid_expiry", "expires_at must be in the future and later than send_at.");
  const device = await db.prepare("SELECT id FROM devices WHERE id=? AND organization_id=? AND status='active'").bind(deviceId, principal.organizationId).first<SqlRow>();
  if (!device) throw new ApiError(404, "device_not_found", "Choose an active phone belonging to your workspace.");
  const optedOut = await db.prepare("SELECT id FROM opt_outs WHERE organization_id=? AND phone_hash=?").bind(principal.organizationId, await digest(`${principal.organizationId}:${to}`)).first<SqlRow>();
  if (optedOut) throw new ApiError(409, "recipient_opted_out", "This recipient is on your workspace's blocklist.");
  const id = crypto.randomUUID();
  const day = at.slice(0, 10) + "T00:00:00.000Z";
  const results = await db.batch([
    db.prepare("INSERT OR IGNORE INTO messages(id,organization_id,device_id,idempotency_hash,payload_hash,status,sandbox,send_at,expires_at,created_at,updated_at) SELECT ?,?,?,?,?,'accepted',?,?,?,?,? WHERE (SELECT COUNT(*) FROM commands WHERE organization_id=? AND acknowledged_at IS NULL AND expires_at>?)<? AND (SELECT COUNT(*) FROM messages WHERE organization_id=? AND created_at>=?)<? AND EXISTS(SELECT 1 FROM devices WHERE id=? AND organization_id=? AND status='active')")
      .bind(id, principal.organizationId, deviceId, idempotencyHash, payloadHash, sandbox ? 1 : 0, sendAt, expires, at, at, principal.organizationId, at, MAX_PENDING_COMMANDS, principal.organizationId, day, MAX_NEW_MESSAGES_PER_DAY, deviceId, principal.organizationId),
    db.prepare("INSERT INTO commands(id,organization_id,device_id,message_id,type,payload_json,expires_at,created_at) SELECT ?,organization_id,device_id,id,'message.send',?,?,? FROM messages WHERE id=?")
      .bind(crypto.randomUUID(), JSON.stringify({ to, content, send_at: sendAt, expires_at: expires, sandbox }), expires, at, id),
  ]);
  if (!results[0].meta.changes) {
    const raced = await db.prepare("SELECT * FROM messages WHERE organization_id=? AND idempotency_hash=?").bind(principal.organizationId, idempotencyHash).first<SqlRow>();
    if (raced) {
      if (raced.payload_hash !== payloadHash) throw new ApiError(409, "idempotency_conflict", "This Idempotency-Key was already used with a different request.");
      return json(messageView(raced), 202, true);
    }
    throw new ApiError(429, "workspace_capacity", "The workspace has reached its daily command allowance or pending handoff limit. Existing phone queues are unaffected.");
  }
  return json(messageView(await messageById(db, principal.organizationId, id)), 202, true);
}

async function pairDevice(request: Request, db: D1Database, url: URL): Promise<Response> {
  const input = await body(request);
  const pairingToken = text(input.pairing_token, "pairing_token", 100);
  if (!/^nb_pair_[a-f0-9]{64}$/.test(pairingToken)) throw new ApiError(401, "invalid_pairing", "This pairing code is invalid or expired. Create a new one in Nabda.");
  const tokenHash = await digest(pairingToken);
  const pairing = await db.prepare("SELECT name FROM pairings WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?").bind(tokenHash, new Date().toISOString()).first<SqlRow>();
  if (!pairing) throw new ApiError(401, "invalid_pairing", "This pairing code is invalid, expired or already used. Create a new one in Nabda.");
  const name = input.name ? text(input.name, "name", 80) : String(pairing.name);
  const deviceId = crypto.randomUUID();
  const deviceToken = secret("nb_device_");
  const at = new Date().toISOString();
  const results = await db.batch([
    db.prepare("UPDATE pairings SET consumed_at=?,consumed_device_id=? WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?").bind(at, deviceId, tokenHash, at),
    db.prepare("INSERT INTO devices(id,organization_id,name,token_hash,status,app_version,android_version,created_at,last_seen_at) SELECT ?,organization_id,?,?,'active',?,?,?,? FROM pairings WHERE token_hash=? AND consumed_device_id=? AND consumed_at=?")
      .bind(deviceId, name, await digest(deviceToken), shortOptional(input.app_version), shortOptional(input.android_version), at, at, tokenHash, deviceId, at),
  ]);
  if (!results[0].meta.changes || !results[1].meta.changes) throw new ApiError(401, "invalid_pairing", "This pairing code has already been used. Create a new one in Nabda.");
  return json({ device_id: deviceId, device_token: deviceToken, server_url: url.origin, poll_after_ms: POLL_AFTER_MS }, 201, true);
}

async function devicePoll(request: Request, db: D1Database, principal: Principal): Promise<Response> {
  const input = await body(request);
  for (const field of ["ready", "permission_granted", "sim_selected"]) {
    if (typeof input[field] !== "boolean") throw new ApiError(422, "validation_error", `${field} must be true or false.`);
  }
  const at = new Date().toISOString();
  await expireCommands(db, principal);
  const oldThreshold = new Date(Date.now() - 120_000).toISOString();
  await db.prepare("UPDATE devices SET ready=?,permission_granted=?,sim_selected=?,app_version=COALESCE(?,app_version),android_version=COALESCE(?,android_version),last_seen_at=? WHERE id=? AND organization_id=? AND status='active' AND (last_seen_at IS NULL OR last_seen_at<? OR ready<>? OR permission_granted<>? OR sim_selected<>?)")
    .bind(input.ready ? 1 : 0, input.permission_granted ? 1 : 0, input.sim_selected ? 1 : 0, shortOptional(input.app_version), shortOptional(input.android_version), at, principal.deviceId!, principal.organizationId, oldThreshold, input.ready ? 1 : 0, input.permission_granted ? 1 : 0, input.sim_selected ? 1 : 0).run();
  const rows = await db.prepare("SELECT id,type,message_id,payload_json FROM commands WHERE device_id=? AND organization_id=? AND acknowledged_at IS NULL AND expires_at>? ORDER BY CASE WHEN type='message.cancel' THEN 0 ELSE 1 END,created_at,id LIMIT 25").bind(principal.deviceId!, principal.organizationId, at).all<SqlRow>();
  return json({ commands: rows.results.map((row) => ({ id: row.id, type: row.type, message_id: row.message_id, payload: JSON.parse(String(row.payload_json ?? "{}")) })), poll_after_ms: POLL_AFTER_MS, server_time: at }, 200, true);
}

async function deviceAck(request: Request, db: D1Database, principal: Principal): Promise<Response> {
  const input = await body(request);
  if (!Array.isArray(input.command_ids) || input.command_ids.length < 1 || input.command_ids.length > 100 || input.command_ids.some((id) => typeof id !== "string" || id.length > 100)) throw new ApiError(422, "validation_error", "command_ids must contain 1–100 command IDs.");
  const acknowledged: string[] = [];
  const rejected: Array<{ id: string; reason: string }> = [];
  const at = new Date().toISOString();
  for (const id of [...new Set(input.command_ids as string[])]) {
    const command = await db.prepare("SELECT id,type,message_id,acknowledged_at FROM commands WHERE id=? AND device_id=? AND organization_id=?").bind(id, principal.deviceId!, principal.organizationId).first<SqlRow>();
    if (!command) { rejected.push({ id, reason: "not_found" }); continue; }
    await db.batch([
      db.prepare("UPDATE messages SET status='on_device',handed_off_at=?,updated_at=? WHERE id=? AND device_id=? AND organization_id=? AND status='accepted' AND expires_at>? AND EXISTS(SELECT 1 FROM commands WHERE id=? AND type='message.send' AND acknowledged_at IS NULL AND expires_at>?)").bind(at, at, command.message_id, principal.deviceId!, principal.organizationId, at, id, at),
      db.prepare("UPDATE commands SET payload_json=NULL,acknowledged_at=COALESCE(acknowledged_at,?) WHERE id=? AND device_id=? AND organization_id=? AND ((type='message.send' AND EXISTS(SELECT 1 FROM messages WHERE id=? AND handed_off_at IS NOT NULL)) OR type='message.cancel')").bind(at, id, principal.deviceId!, principal.organizationId, command.message_id),
    ]);
    const result = await db.prepare("SELECT c.acknowledged_at,c.type,m.status,m.handed_off_at,m.expires_at FROM commands c JOIN messages m ON m.id=c.message_id WHERE c.id=? AND c.device_id=? AND c.organization_id=?").bind(id, principal.deviceId!, principal.organizationId).first<SqlRow>();
    if (result?.acknowledged_at && (result.type === "message.cancel" || result.handed_off_at)) acknowledged.push(id);
    else rejected.push({ id, reason: result?.status === "cancelled" ? "cancelled" : String(result?.expires_at ?? "") <= at ? "expired" : "not_found" });
  }
  return json({ acknowledged, rejected }, 200, true);
}

export function mergeStatus(current: string, incoming: string): string {
  if (current === "delivered") return current;
  if (current === "sent") return incoming === "delivered" ? incoming : current;
  if (["cancelled", "expired", "failed"].includes(current)) return current;
  if (current === "outcome_unknown") return ["sent", "delivered", "failed"].includes(incoming) ? incoming : current;
  if (current === "processing" && incoming === "queued") return current;
  return incoming;
}

function countField(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 100) throw new ApiError(422, "invalid_part_count", `${field} must be an integer from 0 to 100.`);
  return Number(value);
}

async function deviceEvents(request: Request, db: D1Database, principal: Principal): Promise<Response> {
  const input = await body(request);
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 100) throw new ApiError(422, "validation_error", "events must contain 1–100 events.");
  // Validate the entire batch before any event is persisted.
  const validated = [];
  const batchIds = new Map<string, string>();
  for (const item of input.events) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ApiError(422, "validation_error", "Each event must be an object.");
    const event = item as Record<string, unknown>;
    const id = text(event.event_id, "event_id", 100);
    const messageId = text(event.message_id, "message_id", 80);
    const status = text(event.status, "status", 30);
    if (!EVENT_STATUSES.has(status)) throw new ApiError(422, "invalid_status", "The event status is invalid.");
    const total = countField(event.parts_total, "parts_total");
    const sent = countField(event.parts_sent, "parts_sent");
    const delivered = countField(event.parts_delivered, "parts_delivered");
    if ((total !== null && total < 1) || (sent !== null && total === null) || (delivered !== null && (sent === null || total === null)) || (sent !== null && total !== null && sent > total) || (delivered !== null && sent !== null && delivered > sent)) throw new ApiError(422, "invalid_part_count", "Part counts are inconsistent. Include parts_total and parts_sent when reporting part outcomes.");
    if ((status === "sent" && (total === null || sent !== total)) || (status === "delivered" && (total === null || sent !== total || delivered !== total))) throw new ApiError(422, "incomplete_parts", "All parts must be confirmed before reporting sent or delivered.");
    const failure = shortOptional(event.failure_code);
    if (failure && !/^[A-Za-z0-9_.:-]+$/.test(failure)) throw new ApiError(422, "invalid_failure_code", "failure_code must be a short symbolic code, without message contents.");
    const occurredAt = dateField(event.occurred_at, "occurred_at");
    const message = await db.prepare("SELECT * FROM messages WHERE id=? AND organization_id=? AND device_id=?").bind(messageId, principal.organizationId, principal.deviceId!).first<SqlRow>();
    if (!message) throw new ApiError(404, "not_found", "An event's message was not found on this phone.");
    if (!message.handed_off_at) throw new ApiError(409, "handoff_not_acknowledged", "Acknowledge the durable command before uploading its execution events.");
    if (total !== null && message.parts_total !== null && total !== Number(message.parts_total)) throw new ApiError(409, "part_count_conflict", "A message's part count cannot change after it is reported.");
    const payloadHash = await digest(JSON.stringify({ messageId, status, total, sent, delivered, failure, occurredAt }));
    const earlierHash = batchIds.get(id);
    if (earlierHash && earlierHash !== payloadHash) throw new ApiError(409, "event_conflict", "An event ID is repeated with different contents in this batch.");
    if (earlierHash) continue;
    batchIds.set(id, payloadHash);
    const existing = await db.prepare("SELECT payload_hash FROM message_events WHERE device_id=? AND event_id=?").bind(principal.deviceId!, id).first<SqlRow>();
    if (existing && existing.payload_hash !== payloadHash) throw new ApiError(409, "event_conflict", "An event ID was already used with a different event.");
    validated.push({ id, messageId, status, total, sent, delivered, failure, occurredAt, payloadHash, existing: !!existing });
  }
  const accepted: string[] = [];
  for (const event of validated) {
    const at = new Date().toISOString();
    if (!event.existing) {
      const statusSql = `CASE
        WHEN status='delivered' THEN status
        WHEN status='sent' THEN CASE WHEN ?='delivered' THEN 'delivered' ELSE status END
        WHEN status IN('cancelled','expired','failed') THEN status
        WHEN status='outcome_unknown' THEN CASE WHEN ? IN('sent','delivered','failed') THEN ? ELSE status END
        WHEN status='processing' AND ?='queued' THEN status
        ELSE ? END`;
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO message_events(id,event_id,organization_id,device_id,message_id,status,payload_hash,occurred_at,received_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM messages WHERE id=? AND organization_id=? AND device_id=? AND handed_off_at IS NOT NULL AND (? IS NULL OR parts_total IS NULL OR parts_total=?))").bind(crypto.randomUUID(), event.id, principal.organizationId, principal.deviceId!, event.messageId, event.status, event.payloadHash, event.occurredAt, at, event.messageId, principal.organizationId, principal.deviceId!, event.total, event.total),
        // Merge against the row inside the transaction, not a stale pre-read.
        db.prepare(`UPDATE messages SET status=${statusSql},parts_total=COALESCE(parts_total,?),parts_sent=MAX(COALESCE(parts_sent,0),?),parts_delivered=MAX(COALESCE(parts_delivered,0),?),failure_code=CASE WHEN status IN('sent','delivered') THEN NULL WHEN ? IN('sent','delivered') AND status NOT IN('failed','expired','cancelled') THEN NULL WHEN ? IN('failed','outcome_unknown') THEN ? ELSE failure_code END,updated_at=? WHERE id=? AND organization_id=? AND device_id=? AND EXISTS(SELECT 1 FROM message_events WHERE device_id=? AND event_id=? AND payload_hash=?)`)
          .bind(event.status, event.status, event.status, event.status, event.status, event.total, event.sent ?? 0, event.delivered ?? 0, event.status, event.status, event.failure, at, event.messageId, principal.organizationId, principal.deviceId!, principal.deviceId!, event.id, event.payloadHash),
      ]);
      const stored = await db.prepare("SELECT payload_hash FROM message_events WHERE device_id=? AND event_id=?").bind(principal.deviceId!, event.id).first<SqlRow>();
      if (!stored) throw new ApiError(409, "part_count_conflict", "A message's part count cannot change after it is reported.");
      if (stored?.payload_hash !== event.payloadHash) throw new ApiError(409, "event_conflict", "An event ID was already used with a different event.");
    }
    accepted.push(event.id);
  }
  return json({ accepted }, 200, true);
}

/** Returns null for website routes, preserving the framework's routing. */
export async function handleNabdaApi(request: Request, env: ApiEnv, browserUser?: BrowserUser): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (!(path === "/health" || path.startsWith("/api/") || path.startsWith("/v1/"))) return null;
  const publicApi = path.startsWith("/v1/");
  try {
    if (path === "/health" && request.method === "GET") return json({ status: "ok", mode: "phone-owned", version: VERSION });
    if (request.method === "OPTIONS" && publicApi) return json({}, 200, true);
    if (!env.DB) throw new ApiError(503, "database_unavailable", "Nabda's account database is not available yet. Please try again shortly.");
    const db = env.DB;
    if (path.startsWith("/api/")) return await management(request, db, url, browserUser);
    if (path === "/v1/device/pair" && request.method === "POST") return await pairDevice(request, db, url);
    if (path.startsWith("/v1/device/")) {
      const principal = await bearer(request, db, "device");
      if (request.method === "POST" && path === "/v1/device/poll") return await devicePoll(request, db, principal);
      if (request.method === "POST" && path === "/v1/device/ack") return await deviceAck(request, db, principal);
      if (request.method === "POST" && path === "/v1/device/events") return await deviceEvents(request, db, principal);
      throw new ApiError(404, "not_found", "This device endpoint was not found.");
    }
    const principal = await bearer(request, db, "app");
    if (path === "/v1/messages" && request.method === "POST") return await sendMessage(request, db, principal);
    const messageMatch = path.match(/^\/v1\/messages\/([^/]+)$/);
    if (messageMatch && request.method === "GET") return json(messageView(await messageById(db, principal.organizationId, messageMatch[1])), 200, true);
    const cancellation = path.match(/^\/v1\/messages\/([^/]+)\/cancellations$/);
    if (cancellation && request.method === "POST") return json(await cancelMessage(db, principal.organizationId, cancellation[1]), 200, true);
    if (path === "/v1/usage" && request.method === "GET") return json(await usage(db, principal.organizationId), 200, true);
    throw new ApiError(404, "not_found", "This endpoint was not found.");
  } catch (error) {
    if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status, publicApi);
    // Do not return SQL, identifiers, credentials or message payloads on unexpected errors.
    return json({ error: { code: "internal_error", message: "Nabda could not complete this request. Retry with the same Idempotency-Key if you were creating a message." } }, 500, publicApi);
  }
}
