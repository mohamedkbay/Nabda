import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";

// Isolated local Worker + real Miniflare D1. It cannot call a phone or send SMS.
// The test-only wrapper supplies a trusted principal directly to the handler.
// It is never deployed; production authenticates independently before this seam.
const bundled = await build({
  stdin: {
    contents: 'import {handleNabdaApi} from "./lib/nabda-api.ts"; export default {async fetch(request,env){const id=request.headers.get("x-test-principal");const user=id?{id,email:`${id}@example.test`,name:id}:undefined;return await handleNabdaApi(request,env,user) ?? new Response("not found",{status:404})}};',
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
});
const mf = new Miniflare({
  modules: true, script: bundled.outputFiles[0].text,
  compatibilityDate: "2026-05-15", d1Databases: ["DB"],
  log: new Log(LogLevel.ERROR), cf: false,
});
let passed = 0;
const failures = [];
const db = await mf.getD1Database("DB");
const migrationFiles = (await fs.readdir("drizzle")).filter((name) => name.endsWith(".sql")).sort();
for (const name of migrationFiles) {
  const sql = await fs.readFile(`drizzle/${name}`, "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
}
const root = "https://nabda-verification.test";
const identity = (id) => ({ "x-test-principal": id });
async function request(path, { method = "GET", body, token, user, headers = {}, raw } = {}) {
  const requestHeaders = { ...(user ? identity(user) : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers };
  if (body !== undefined || raw !== undefined) requestHeaders["Content-Type"] ??= "application/json";
  const response = await mf.dispatchFetch(root + path, {
    method, headers: requestHeaders, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(raw !== undefined ? { body: raw } : {}),
  });
  const value = await response.json();
  return { status: response.status, body: value, headers: response.headers };
}
async function expect(path, options, status) {
  const response = await request(path, options);
  assert.equal(response.status, status, `${options?.method ?? "GET"} ${path}: ${JSON.stringify(response.body)}`);
  return response.body;
}
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, message: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}
const appRequest = (token, body, id) => ({ method: "POST", token, body, headers: { "Idempotency-Key": id } });
const sendBody = (device, extra = {}) => ({ device_id: device, to: "+12025550123", content: "  Local sandbox verification\n  ", sandbox: true, ...extra });
const pollBody = { ready: true, permission_granted: true, sim_selected: true, app_version: "verification-sandbox", android_version: "simulated" };
const now = () => new Date().toISOString();
function makeEvent(id, status, extra = {}) {
  return { event_id: crypto.randomUUID(), message_id: id, status, occurred_at: now(), ...extra };
}
async function poll(device) {
  return expect("/v1/device/poll", { method: "POST", token: device.device_token, body: pollBody }, 200);
}
async function ack(device, ids) {
  return expect("/v1/device/ack", { method: "POST", token: device.device_token, body: { command_ids: ids } }, 200);
}
async function onDevice(token, device, tag) {
  const message = await expect("/v1/messages", appRequest(token, sendBody(device.device_id), tag), 202);
  const polled = await poll(device);
  const command = polled.commands.find((item) => item.message_id === message.id && item.type === "message.send");
  assert.ok(command, "send command exists");
  const result = await ack(device, [command.id]);
  assert.ok(result.acknowledged.includes(command.id));
  return { message, command };
}

try {
  await check("health exposes no credentials", async () => {
    const health = await expect("/health", undefined, 200);
    assert.equal(health.mode, "phone-owned");
    assert.deepEqual(Object.keys(health).sort(), ["mode", "status", "version"]);
  });
  await check("anonymous management and unauthenticated app endpoints reject", async () => {
    await expect("/api/account", undefined, 401);
    await expect("/api/keys", { method: "POST", body: { name: "unauthorized" } }, 401);
    await expect("/api/pairings", { method: "POST", body: { name: "unauthorized" } }, 401);
    await expect("/v1/usage", undefined, 401);
  });
  const accountA = await expect("/api/account", { user: "verify-a" }, 200);
  const accountB = await expect("/api/account", { user: "verify-b" }, 200);
  assert.notEqual(accountA.organization.id, accountB.organization.id);
  const keyA = await expect("/api/keys", { method: "POST", user: "verify-a", body: { name: "Sandbox A" } }, 201);
  const keyB = await expect("/api/keys", { method: "POST", user: "verify-b", body: { name: "Sandbox B" } }, 201);
  await check("management lists and storage contain no plaintext API key", async () => {
    const account = await expect("/api/account", { user: "verify-a" }, 200);
    assert.ok(!JSON.stringify(account).includes(keyA.key));
    assert.ok(!JSON.stringify(account).includes("token_hash"));
    const row = await db.prepare("SELECT token_hash FROM api_keys WHERE id=?").bind(keyA.id).first();
    assert.notEqual(row.token_hash, keyA.key);
    assert.match(row.token_hash, /^[a-f0-9]{64}$/);
  });
  await check("cross-site management mutation rejects", async () => {
    await expect("/api/keys", { method: "POST", user: "verify-a", body: { name: "CSRF" }, headers: { Origin: "https://other.example" } }, 403);
    await expect("/api/pairings", { method: "POST", user: "verify-a", body: {}, headers: { "Sec-Fetch-Site": "cross-site" } }, 403);
  });
  const pairingA = await expect("/api/pairings", { method: "POST", user: "verify-a", body: { name: "Sandbox phone A" } }, 201);
  const pairedResponses = await Promise.all([
    request("/v1/device/pair", { method: "POST", body: { pairing_token: pairingA.pairing_token } }),
    request("/v1/device/pair", { method: "POST", body: { pairing_token: pairingA.pairing_token } }),
  ]);
  await check("concurrent pairing creates exactly one device", async () => {
    assert.deepEqual(pairedResponses.map((result) => result.status).sort(), [201, 401]);
    const count = await db.prepare("SELECT COUNT(*) AS count FROM devices WHERE organization_id=?").bind(accountA.organization.id).first();
    assert.equal(count.count, 1);
  });
  const deviceA = pairedResponses.find((result) => result.status === 201)?.body;
  assert.ok(deviceA, "pairing setup succeeded");
  const pairingB = await expect("/api/pairings", { method: "POST", user: "verify-b", body: { name: "Sandbox phone B" } }, 201);
  const deviceB = await expect("/v1/device/pair", { method: "POST", body: { pairing_token: pairingB.pairing_token } }, 201);
  await check("expired pairing token rejects", async () => {
    const pairing = await expect("/api/pairings", { method: "POST", user: "verify-a", body: {} }, 201);
    await db.prepare("UPDATE pairings SET expires_at='2000-01-01T00:00:00.000Z' WHERE organization_id=? AND consumed_at IS NULL").bind(accountA.organization.id).run();
    await expect("/v1/device/pair", { method: "POST", body: { pairing_token: pairing.pairing_token } }, 401);
  });
  await check("application and device credentials are not interchangeable", async () => {
    await expect("/v1/device/poll", { method: "POST", token: keyA.key, body: pollBody }, 401);
    await expect("/v1/messages", appRequest(deviceA.device_token, sendBody(deviceA.device_id), "separate-key-types"), 401);
  });
  const mainPayload = sendBody(deviceA.device_id);
  const main = await expect("/v1/messages", appRequest(keyA.key, mainPayload, "sandbox-main-message"), 202);
  await check("idempotent retries preserve identity and changed payload conflicts", async () => {
    const again = await expect("/v1/messages", appRequest(keyA.key, mainPayload, "sandbox-main-message"), 202);
    assert.equal(again.id, main.id);
    await expect("/v1/messages", appRequest(keyA.key, { ...mainPayload, content: "different" }, "sandbox-main-message"), 409);
    const row = await db.prepare("SELECT COUNT(*) AS count FROM commands WHERE message_id=?").bind(main.id).first();
    assert.equal(row.count, 1);
  });
  await check("concurrent idempotent requests produce one command", async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => request("/v1/messages", appRequest(keyA.key, mainPayload, "sandbox-concurrent-create"))));
    assert.ok(responses.every((result) => result.status === 202));
    assert.equal(new Set(responses.map((result) => result.body.id)).size, 1);
    const row = await db.prepare("SELECT COUNT(*) AS count FROM commands WHERE message_id=?").bind(responses[0].body.id).first();
    assert.equal(row.count, 1);
  });
  await check("organization and device scoping rejects foreign resources", async () => {
    await expect(`/v1/messages/${main.id}`, { token: keyB.key }, 404);
    await expect("/v1/messages", appRequest(keyB.key, mainPayload, "foreign-device-create"), 404);
    await expect(`/api/messages/${main.id}/cancel`, { method: "POST", user: "verify-b" }, 404);
    await expect(`/api/devices/${deviceA.device_id}`, { method: "DELETE", user: "verify-b" }, 404);
    const b = await expect("/v1/messages", appRequest(keyB.key, { ...sendBody(deviceB.device_id), organization_id: accountA.organization.id }, "spoofed-organization"), 202);
    const row = await db.prepare("SELECT organization_id FROM messages WHERE id=?").bind(b.id).first();
    assert.equal(row.organization_id, accountB.organization.id);
  });
  await check("input validation bounds reject invalid work", async () => {
    await expect("/v1/messages", appRequest(keyA.key, { ...mainPayload, content: " " }, "empty-content-key"), 422);
    await expect("/v1/messages", appRequest(keyA.key, { ...mainPayload, content: "x".repeat(4001) }, "large-content-key"), 422);
    await expect("/v1/messages", appRequest(keyA.key, { ...mainPayload, to: "not-a-phone" }, "invalid-phone-key"), 422);
    await expect("/v1/messages", appRequest(keyA.key, { ...mainPayload, send_at: "2026-11-08T12:00:00" }, "missing-timezone-key"), 422);
    await expect("/v1/messages", { method: "POST", token: keyA.key, body: mainPayload }, 422);
    await expect("/v1/messages", { method: "POST", token: keyA.key, raw: "{" + "x".repeat(132000), headers: { "Idempotency-Key": "oversize-request-key" } }, 413);
  });
  let mainCommand;
  await check("poll redelivers unacknowledged work and preserves whitespace", async () => {
    const one = await poll(deviceA);
    const two = await poll(deviceA);
    mainCommand = one.commands.find((command) => command.message_id === main.id);
    assert.ok(mainCommand);
    assert.equal(mainCommand.payload.content, mainPayload.content);
    assert.equal(mainCommand.payload.sandbox, true);
    assert.ok(two.commands.some((command) => command.id === mainCommand.id));
    assert.ok(one.poll_after_ms >= 60000);
  });
  await check("execution events cannot precede durable handoff", async () => {
    await expect("/v1/device/events", { method: "POST", token: deviceA.device_token, body: { events: [makeEvent(main.id, "sent", { parts_total: 1, parts_sent: 1 })] } }, 409);
  });
  await check("foreign device cannot acknowledge another device command", async () => {
    const result = await ack(deviceB, [mainCommand.id]);
    assert.ok(!result.acknowledged.includes(mainCommand.id));
    const row = await db.prepare("SELECT acknowledged_at FROM commands WHERE id=?").bind(mainCommand.id).first();
    assert.equal(row.acknowledged_at, null);
  });
  await check("ACK purges cloud recipient and body, and duplicate ACK remains safe", async () => {
    const one = await ack(deviceA, [mainCommand.id]);
    assert.ok(one.acknowledged.includes(mainCommand.id));
    const two = await ack(deviceA, [mainCommand.id]);
    assert.ok(two.acknowledged.includes(mainCommand.id));
    const row = await db.prepare("SELECT payload_json FROM commands WHERE id=?").bind(mainCommand.id).first();
    assert.equal(row.payload_json, null);
    const message = await expect(`/v1/messages/${main.id}`, { token: keyA.key }, 200);
    assert.equal(message.status, "on_device");
    assert.ok(!JSON.stringify(message).includes(mainPayload.content));
    assert.ok(!JSON.stringify(message).includes(mainPayload.to));
  });
  await check("partial part counts cannot claim full delivery", async () => {
    await expect("/v1/device/events", { method: "POST", token: deviceA.device_token, body: { events: [makeEvent(main.id, "delivered", { parts_total: 2, parts_sent: 2, parts_delivered: 1 })] } }, 422);
    await expect("/v1/device/events", { method: "POST", token: deviceA.device_token, body: { events: [makeEvent(main.id, "processing", { parts_total: 1, parts_delivered: 100 })] } }, 422);
  });
  const sent = makeEvent(main.id, "sent", { parts_total: 2, parts_sent: 2, parts_delivered: 0 });
  await check("status event retry is idempotent and conflicting ID rejects", async () => {
    await expect("/v1/device/events", { method: "POST", token: deviceA.device_token, body: { events: [sent] } }, 200);
    await expect("/v1/device/events", { method: "POST", token: deviceA.device_token, body: { events: [sent] } }, 200);
    await expect("/v1/device/events", { method: "POST", token: deviceA.device_token, body: { events: [{ ...sent, status: "failed", failure_code: "DIFFERENT" }] } }, 409);
    const count = await db.prepare("SELECT COUNT(*) AS count FROM message_events WHERE device_id=? AND event_id=?").bind(deviceA.device_id, sent.event_id).first();
    assert.equal(count.count, 1);
  });
  await check("stale queued status cannot regress sent or delivered", async () => {
    await expect("/v1/device/events", { method: "POST", token: deviceA.device_token, body: { events: [makeEvent(main.id, "queued", { parts_total: 2 })] } }, 200);
    assert.equal((await expect(`/v1/messages/${main.id}`, { token: keyA.key }, 200)).status, "sent");
    await expect("/v1/device/events", { method: "POST", token: deviceA.device_token, body: { events: [makeEvent(main.id, "delivered", { parts_total: 2, parts_sent: 2, parts_delivered: 2 })] } }, 200);
    assert.equal((await expect(`/v1/messages/${main.id}`, { token: keyA.key }, 200)).status, "delivered");
  });
  await check("conflicting duplicate event IDs in one batch reject without mutation", async () => {
    const { message } = await onDevice(keyA.key, deviceA, "duplicate-batch-event-message");
    const event = makeEvent(message.id, "processing", { parts_total: 1 });
    await expect("/v1/device/events", { method: "POST", token: deviceA.device_token, body: { events: [event, { ...event, status: "sent", parts_sent: 1 }] } }, 409);
    const row = await db.prepare("SELECT COUNT(*) AS count FROM message_events WHERE message_id=?").bind(message.id).first();
    assert.equal(row.count, 0);
  });
  await check("concurrent sent and delivered events retain delivered result", async () => {
    const { message } = await onDevice(keyA.key, deviceA, "concurrent-status-message");
    const sentEvent = makeEvent(message.id, "sent", { parts_total: 2, parts_sent: 2, parts_delivered: 0 });
    const deliveredEvent = makeEvent(message.id, "delivered", { parts_total: 2, parts_sent: 2, parts_delivered: 2 });
    const outcomes = await Promise.all([request("/v1/device/events", { method: "POST", token: deviceA.device_token, body: { events: [sentEvent] } }), request("/v1/device/events", { method: "POST", token: deviceA.device_token, body: { events: [deliveredEvent] } })]);
    assert.ok(outcomes.every((response) => response.status === 200));
    const result = await expect(`/v1/messages/${message.id}`, { token: keyA.key }, 200);
    assert.equal(result.status, "delivered");
    assert.equal(result.parts_delivered, 2);
  });
  await check("cancellation between poll and ACK blocks handoff and clears payload", async () => {
    const message = await expect("/v1/messages", appRequest(keyA.key, mainPayload, "cancel-before-ack-message"), 202);
    const command = (await poll(deviceA)).commands.find((item) => item.message_id === message.id);
    const cancelled = await expect(`/api/messages/${message.id}/cancel`, { method: "POST", user: "verify-a" }, 200);
    assert.equal(cancelled.guaranteed, true);
    const result = await ack(deviceA, [command.id]);
    assert.ok(!result.acknowledged.includes(command.id));
    assert.ok(result.rejected.some((item) => item.id === command.id && item.reason === "cancelled"));
    assert.equal((await db.prepare("SELECT payload_json FROM commands WHERE id=?").bind(command.id).first()).payload_json, null);
  });
  await check("post-handoff cancellation does not falsely report cancelled", async () => {
    const { message } = await onDevice(keyA.key, deviceA, "cancel-after-ack-message");
    const cancelled = await expect(`/api/messages/${message.id}/cancel`, { method: "POST", user: "verify-a" }, 200);
    assert.equal(cancelled.guaranteed, false);
    assert.notEqual(cancelled.status, "cancelled");
    const cancellationCommand = (await poll(deviceA)).commands.find((item) => item.message_id === message.id && item.type === "message.cancel");
    assert.ok(cancellationCommand);
    await ack(deviceA, [cancellationCommand.id]);
    assert.notEqual((await expect(`/v1/messages/${message.id}`, { token: keyA.key }, 200)).status, "cancelled");
  });
  await check("expired send cannot gain execution approval after polling", async () => {
    const message = await expect("/v1/messages", appRequest(keyA.key, mainPayload, "expired-after-poll-message"), 202);
    const command = (await poll(deviceA)).commands.find((item) => item.message_id === message.id);
    await db.batch([
      db.prepare("UPDATE messages SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(message.id),
      db.prepare("UPDATE commands SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(command.id),
    ]);
    const result = await ack(deviceA, [command.id]);
    assert.ok(!result.acknowledged.includes(command.id));
    assert.ok(result.rejected.some((item) => item.reason === "expired"));
    await poll(deviceA);
    assert.equal((await db.prepare("SELECT payload_json FROM commands WHERE id=?").bind(command.id).first()).payload_json, null);
  });
  await check("global counts are independent of page size and cursor advances", async () => {
    const page = await expect("/api/messages?limit=2", { user: "verify-a" }, 200);
    assert.equal(page.messages.length, 2);
    assert.ok(Object.values(page.counts).reduce((sum, value) => sum + value, 0) > 2);
    assert.ok(page.next_cursor);
    const next = await expect(`/api/messages?limit=2&cursor=${encodeURIComponent(page.next_cursor)}`, { user: "verify-a" }, 200);
    const firstIds = new Set(page.messages.map((item) => item.id));
    assert.ok(next.messages.every((item) => !firstIds.has(item.id)));
  });
  await check("revoked application key stops accepting work", async () => {
    await expect(`/api/keys/${keyB.id}`, { method: "DELETE", user: "verify-b" }, 200);
    await expect("/v1/usage", { token: keyB.key }, 401);
  });
  await check("device revocation stops new polling and cancels unhanded work", async () => {
    await expect(`/api/devices/${deviceB.device_id}`, { method: "DELETE", user: "verify-b" }, 200);
    await expect("/v1/device/poll", { method: "POST", token: deviceB.device_token, body: pollBody }, 401);
    const pending = await db.prepare("SELECT COUNT(*) AS count FROM commands WHERE device_id=? AND acknowledged_at IS NULL").bind(deviceB.device_id).first();
    assert.equal(pending.count, 0);
  });
} finally {
  await mf.dispose();
}
console.log(JSON.stringify({ sandbox: true, passed, failed: failures.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
